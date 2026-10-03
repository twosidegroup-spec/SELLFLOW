package com.sellflow.sms

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import com.sellflow.sms.providers.ParseOutcome
import com.sellflow.sms.providers.PaymentCandidate
import com.sellflow.sms.providers.Provider
import com.sellflow.sms.providers.ProviderRegistry
import com.sellflow.sms.providers.SmsMessage
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The JavaScript-facing surface of the native listener.
 *
 * Deliberately narrow: report status, drain candidates, discard one. There is no
 * method that accepts a message, none that returns a raw body, and none that
 * parses anything. JavaScript cannot ask this module to do more than hand over
 * candidates it has already decided are real, which is what keeps the privacy
 * contract a property of the architecture rather than of anyone's discipline.
 *
 * The permission itself is requested from JavaScript through React Native's
 * `PermissionsAndroid`, which already knows `RECEIVE_SMS`. That means no custom
 * permission UI and no second permission mechanism to keep in step.
 */
class SellflowSmsModule : Module() {

    private fun queue(): CandidateQueue = CandidateQueue(appContext.reactContext ?: appContext.applicationContext)

    override fun definition() = ModuleDefinition {
        Name(MODULE_NAME)

        Events(EVENT_CANDIDATE_DETECTED)

        AsyncFunction("getListenerStatusAsync") {
            val queue = queue()
            val appVersion = runCatching {
                val info = appContext.reactContext?.packageManager
                    ?.getPackageInfo(appContext.reactContext.packageName, 0)
                info?.versionName
            }.getOrNull() ?: "unknown"

            mapOf(
                "permission" to if (hasSmsPermission()) "granted" else "denied",
                "receiverActive" to isReceiverActive(appContext.reactContext ?: appContext.applicationContext),
                "appVersion" to appVersion,
                "androidRelease" to (Build.VERSION.RELEASE ?: "unknown"),
                "queuedCandidates" to queue.count(),
                "oldestQueuedAt" to queue.oldestDetectedAt(),
                "rejections" to queue.rejectionCounts(),
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
                    "rejected" to outcome.rejection.reason.id,
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

    private fun hasSmsPermission(): Boolean {
        val context = appContext.reactContext ?: appContext.applicationContext
        return context.checkSelfPermission(Manifest.permission.RECEIVE_SMS) ==
            PackageManager.PERMISSION_GRANTED
    }

    private companion object {
        const val MODULE_NAME = "SellflowSms"
        const val EVENT_CANDIDATE_DETECTED = "onPaymentCandidateDetected"
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
