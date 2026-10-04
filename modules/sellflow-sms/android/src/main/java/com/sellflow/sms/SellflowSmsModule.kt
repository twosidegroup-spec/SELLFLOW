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
                // Listener counters. These are what turn "SellFlow did not detect my
                // payment" into an answerable question: `broadcastsReceived == 0`
                // means the platform never delivered an SMS to this app, which is a
                // manifest/permission/battery problem, while a non-zero count with a
                // `rejected:*` last outcome means the message arrived and this
                // module declined it. Counts only -- no text, no sender address.
                "broadcastsReceived" to (queue?.broadcastsReceived() ?: 0),
                "messagesExamined" to (queue?.examinedCount() ?: 0),
                "unreadableMessages" to (queue?.unreadableCount() ?: 0),
                "lastMessageAt" to (queue?.lastMessageAt() ?: 0L),
                "lastOutcome" to (queue?.lastOutcome() ?: "none"),
                "droppedCandidates" to (queue?.droppedCount() ?: 0),
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
         * Which originating addresses this build recognises, per provider.
         *
         * Addresses are normalised to letters and digits, upper-cased, and held in
         * a closed set per provider. Exposed because they are not publicly
         * documented and therefore need confirming against a real handset: a
         * developer who can see the expected list can check it against what the
         * device actually received. Returning them is safe -- they are the
         * provider's own published identities, not anyone's personal data.
         */
        AsyncFunction("getRecognisedSendersAsync") {
            ProviderRegistry.adapters.associate { it.provider.id to it.senderIdentities.sorted() }
        }

        /**
         * Clears the listener counters so the next real message can be observed from
         * a known starting point.
         *
         * Development diagnostics only, and it deliberately does not clear the
         * candidate queue: those rows are real money movements that have not reached
         * the server yet.
         */
        AsyncFunction("resetListenerDiagnosticsAsync") {
            queue().resetDiagnostics()
            true
        }

        /**
         * Parses a message the developer pasted, without keeping it anywhere.
         *
         * The String lives as one call argument and one `SmsMessage`, and nothing
         * writes it, logs it or sends it: the return value is a detection result, a
         * normalised candidate or a rejection reason, and a hash for comparison
         * against a real device. This exists so a real captured provider message can
         * confirm or extend a parser -- see docs/device-setup.md -- and it
         * deliberately has no path to the ingestion queue.
         *
         * **[sender] is the important argument.** Detection reads the originating
         * address as well as the body, and a paste with no address can only ever
         * exercise the body half of it -- which is exactly the half that already
         * worked, and exactly how the real 65 BDT payment went undetected while
         * every fixture passed. Letting the developer state the sender is what makes
         * a paste reproduce the device.
         *
         * [detected] is reported separately from [outcome] so a refusal can say
         * *which* provider claimed the message before saying what was wrong with
         * it. Detection and parsing fail for different reasons and a developer
         * needs to know which one happened.
         *
         * [sender] is nullable rather than defaulted because this is a lambda: a
         * Kotlin lambda cannot carry a default parameter value, and `String?` is how
         * an Expo module declares an optional argument.
         */
        AsyncFunction("parseMessageForDiagnosticsAsync") { body: String, sender: String? ->
            val message = SmsMessage(
                sender = sender.orEmpty(),
                messageBody = body,
                receivedAt = System.currentTimeMillis(),
                fingerprint = Fingerprint.sha256(body),
            )
            val detected = ProviderRegistry.detect(message)?.provider?.id

            when (val outcome = ProviderRegistry.parse(message)) {
                is ParseOutcome.Parsed -> mapOf(
                    "detected" to detected,
                    "outcome" to "parsed",
                    "candidate" to outcome.candidate.toEventMap(),
                    "fingerprint" to message.fingerprint,
                )
                is ParseOutcome.Rejected -> mapOf(
                    "detected" to detected,
                    "outcome" to "rejected",
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
