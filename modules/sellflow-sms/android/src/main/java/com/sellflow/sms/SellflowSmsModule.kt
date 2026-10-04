package com.sellflow.sms

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import com.sellflow.sms.providers.ParseOutcome
import com.sellflow.sms.providers.PaymentCandidate
import com.sellflow.sms.providers.Provider
import com.sellflow.sms.providers.ProviderRegistry
import com.sellflow.sms.providers.SmsMessage
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

/**
 * The JavaScript-facing surface of the native listener.
 *
 * Deliberately narrow: report status, drain candidates, acknowledge or discard
 * one. There is no method that accepts a message, none that returns a raw body,
 * and none that parses anything a seller could turn into a payment. JavaScript
 * cannot ask this module to do more than hand over candidates it has already
 * decided are real, which is what keeps the privacy contract a property of the
 * architecture rather than of anyone's discipline.
 *
 * The permission itself is requested from JavaScript through React Native's
 * `PermissionsAndroid`, which already knows `RECEIVE_SMS`. That means no custom
 * permission UI and no second permission mechanism to keep in step.
 */
class SellflowSmsModule : Module() {

    /**
     * The Android Context, or null when JavaScript is not running.
     *
     * `AppContext.reactContext` is nullable and there is no `applicationContext`
     * shortcut, so the null case is handled honestly rather than papered over: the
     * queue is only ever needed while JS is alive, and the receiver -- which does
     * the work when JS is not -- has a real Context of its own.
     */
    private fun context(): Context? = appContext.reactContext

    private fun requireContext(): Context =
        context() ?: throw IllegalStateException(
            "The SellFlow SMS listener has no Android context. This happens when the " +
                "React context is gone; the receiver keeps queuing candidates natively " +
                "and JavaScript picks them up when it starts.",
        )

    private fun queue(): CandidateQueue = CandidateQueue(requireContext())

    override fun definition() = ModuleDefinition {
        Name(MODULE_NAME)

        // Published for the receiver, which runs with no React context and
        // therefore cannot reach the module registry itself.
        OnCreate { publishContext(appContext) }

        Events(EVENT_CANDIDATE_DETECTED)

        AsyncFunction("getListenerStatusAsync") {
            val context = context()
            val queue = context?.let { CandidateQueue(it) }

            val appVersion = runCatching {
                context?.packageManager?.getPackageInfo(context.packageName, 0)?.versionName
            }.getOrNull() ?: "unknown"

            mapOf(
                // "unsupported" rather than "denied" when there is no context at
                // all: the honest answer is that we cannot tell, not that the
                // seller refused.
                "permission" to when {
                    context == null -> "unsupported"
                    hasSmsPermission(context) -> "granted"
                    else -> "denied"
                },
                "receiverActive" to (context?.let { isReceiverActive(it) } ?: false),
                "appVersion" to appVersion,
                "androidRelease" to (Build.VERSION.RELEASE ?: "unknown"),
                "queuedCandidates" to (queue?.count() ?: 0),
                "oldestQueuedAt" to (queue?.oldestDetectedAt() ?: 0L),
                "rejections" to (queue?.rejectionCounts() ?: emptyMap<String, Int>()),
            )
        }

        AsyncFunction("getQueuedCandidateCountAsync") { queue().count() }

        /**
         * Every queued candidate, oldest first, WITHOUT removing them.
         *
         * JavaScript persists the batch into its own durable queue and only then
         * acknowledges. Reading is not consuming, so a process death in between
         * causes a redelivery rather than a lost payment.
         */
        AsyncFunction("peekCandidatesAsync") {
            queue().peek().map { it.toEventMap() }
        }

        /**
         * Removes candidates JavaScript has persisted.
         *
         * Called only after the batch is safely in the JS queue, so this queue is
         * a hand-off buffer rather than a second source of truth.
         */
        AsyncFunction("acknowledgeCandidatesAsync") { fingerprints: List<String> ->
            queue().acknowledge(fingerprints)
        }

        /**
         * Drops a candidate the server has definitively refused.
         *
         * Only ever called for an account the seller does not own, a provider the
         * account does not use, or one that aged out. Never for a transient
         * failure: those are retried, because dropping them would lose a real
         * payment to a dropped connection.
         */
        AsyncFunction("discardCandidateAsync") { fingerprint: String ->
            queue().discard(fingerprint)
        }

        /** Which providers this build can parse. Used by the diagnostics screen. */
        AsyncFunction("getSupportedProvidersAsync") {
            ProviderRegistry.adapters.map { it.provider.id to it.parserVersion }
        }

        /**
         * Parses a message the developer pasted, without keeping it anywhere.
         *
         * The String lives as one call argument and one `SmsMessage`, and nothing
         * writes it, logs it or sends it: the return value is either a normalised
         * candidate or a rejection reason, and a hash for comparison against a
         * real device. This exists so a real captured provider message can confirm
         * or extend a parser -- see docs/device-setup.md -- and it deliberately
         * has no path to the ingestion queue.
         */
        AsyncFunction("parseMessageForDiagnosticsAsync") { body: String ->
            val sender = "diagnostics"
            val message = SmsMessage(
                sender = sender,
                messageBody = body,
                receivedAt = System.currentTimeMillis(),
                fingerprint = Fingerprint.sha256(body),
            )
            when (val outcome = ProviderRegistry.parse(message)) {
                is ParseOutcome.Parsed -> mapOf(
                    "candidate" to outcome.candidate.toEventMap(),
                    "fingerprint" to message.fingerprint,
                )
                is ParseOutcome.Rejected -> mapOf(
                    "rejected" to outcome.reason.id,
                    "fingerprint" to message.fingerprint,
                )
            }
        }
    }

    /**
     * Tells a running JS context that the queue grew.
     *
     * Only a nudge. JS responds by draining, so it never trusts a payload from
     * the broadcast path and always reads the durable queue instead.
     */
    fun emitQueuedCandidateChanged(fingerprint: String) {
        sendEvent(EVENT_CANDIDATE_DETECTED, mapOf("fingerprint" to fingerprint))
    }

    private fun hasSmsPermission(context: Context): Boolean =
        context.checkSelfPermission(Manifest.permission.RECEIVE_SMS) ==
            PackageManager.PERMISSION_GRANTED

    companion object {
        const val MODULE_NAME = "SellflowSms"
        private const val EVENT_CANDIDATE_DETECTED = "onPaymentCandidateDetected"

        /**
         * The module instance, published so the broadcast receiver can reach it.
         *
         * `AppContext` has no `applicationContext` and the receiver is handed an
         * Android `Context`, not an `AppContext`, so there is no supported way to
         * walk from one to the other. Holding the module here is the honest
         * solution: the receiver asks for it only as an OPTIMISATION, and every
         * payment has already been written to the durable queue before it does.
         *
         * A weak reference, so this cannot keep the runtime alive after React
         * Native has gone.
         */
        @Volatile
        private var instance: WeakReference<SellflowSmsModule>? = null

        /** The live module, or null when JavaScript is not running. */
        @JvmStatic
        fun live(): SellflowSmsModule? = instance?.get()

        private fun publishContext(context: AppContext) {
            instance = context.registry.getModule(MODULE_NAME)
                ?.let { WeakReference(it as? SellflowSmsModule ?: return) }
        }
    }
}

/**
 * A candidate as JavaScript sees it.
 *
 * Field names are the ingest RPC's own argument names, so the JS layer maps a
 * candidate to an ingest call by reading names rather than by remembering a
 * translation. That is deliberate: a mismatch here would be silent, and a silent
 * mismatch in this layer means the wrong amount reaches the ledger.
 */
internal fun PaymentCandidate.toEventMap(): Map<String, Any?> = mapOf(
    "provider" to provider.id,
    "transactionId" to transactionId,
    "amount" to amount,
    "receiverAccount" to receiverAccount,
    "senderAccount" to senderAccount,
    "transactionTimestamp" to transactionTimestamp,
    "fingerprint" to fingerprint,
    "detectedAt" to detectedAt,
    "parserVersion" to parserVersion,
)
