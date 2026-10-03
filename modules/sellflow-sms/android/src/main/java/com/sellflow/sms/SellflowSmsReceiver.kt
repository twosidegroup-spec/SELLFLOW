package com.sellflow.sms

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import com.sellflow.sms.providers.ParseOutcome
import com.sellflow.sms.providers.ProviderRegistry
import com.sellflow.sms.providers.SmsMessage

/**
 * Receives inbound SMS and turns payment notifications into normalised
 * candidates.
 *
 * Declared in the app manifest by `plugins/withSellflowSms.js`, which adds both
 * this receiver and the `RECEIVE_SMS` permission, so the entire native SMS
 * surface is visible in one reviewable file rather than arriving implicitly
 * through a dependency.
 *
 * Android delivers `SMS_RECEIVED` to every app that asks for it, not only to the
 * default SMS handler. That is the whole reason this works without SellFlow
 * becoming an SMS app: it never reads `content://sms`, never asks for
 * `READ_SMS`, never composes or forwards a message, and is not the default SMS
 * handler. Only the payment notification is read, and only its fields.
 *
 * What this receiver is careful about:
 *
 *  - **The body is not stored.** [message] holds it for one call to
 *    [ProviderRegistry.parse] and is then unreachable. It is not written to the
 *    queue, not logged, not attached to an exception and not sent anywhere.
 *  - **An unrecognised message leaves no trace.** Not even a row saying one
 *    arrived. A seller's personal messages are none of SellFlow's business.
 *  - **A parse crash cannot lose a payment silently.** [ProviderRegistry.parse]
 *    never throws; a failure is counted, and the count is visible in
 *    diagnostics.
 */
class SellflowSmsReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val parts = runCatching { Telephony.Sms.Intents.getMessagesFromIntent(intent) }
            .getOrNull()
            ?: return

        val queue = CandidateQueue(context)

        for (part in parts) {
            val sender = part.displayOriginatingAddress ?: part.originatingAddress ?: continue
            val body = part.displayMessageBody ?: part.messageBody ?: continue
            val receivedAt =
                part.timestampMillis.takeIf { it > 0L } ?: System.currentTimeMillis()

            val message = SmsMessage(
                sender = sender,
                messageBody = body,
                receivedAt = receivedAt,
                fingerprint = Fingerprint.sha256(body),
            )

            when (val outcome = ProviderRegistry.parse(message)) {
                is ParseOutcome.Parsed -> {
                    queue.enqueue(outcome.candidate)
                    notifyJavaScriptIfRunning(context, outcome.candidate.fingerprint)
                }
                is ParseOutcome.Rejected -> queue.recordRejection(outcome.rejection.reason.id)
            }
            // `message` goes out of scope here. Nothing above kept its text.
        }
    }

    /**
     * Best-effort wake of a running JavaScript context.
     *
     * Purely an optimisation. When the app is closed there is no React context
     * and nothing is sent -- which is fine, because the candidate is already in
     * [CandidateQueue] and the app drains the queue the moment it next starts.
     * The queue is the guarantee; this is the fast path.
     */
    private fun notifyJavaScriptIfRunning(context: Context, fingerprint: String) {
        runCatching {
            val appContext = context.applicationContext as? expo.modules.kotlin.AppContext ?: return
            val module = appContext.getModule(MODULE_NAME) as? SellflowSmsModule ?: return
            module.emitQueuedCandidateChanged(fingerprint)
        }
    }

    private companion object {
        const val MODULE_NAME = "SellflowSms"
    }
}

/**
 * Whether the platform will actually deliver broadcasts to this receiver.
 *
 * Reported in diagnostics rather than assumed. A receiver that was disabled in
 * system settings, or that a build failed to register, is a silent failure
 * otherwise: the seller would see "connected" and simply never get payments
 * detected.
 */
internal fun isReceiverActive(context: Context): Boolean = runCatching {
    val component = ComponentName(context, SellflowSmsReceiver::class.java)
    val info = context.packageManager.getReceiverInfo(component, 0)
    info.enabled && info.exported
}.getOrDefault(false)