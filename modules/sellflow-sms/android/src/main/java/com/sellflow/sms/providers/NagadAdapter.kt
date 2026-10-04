package com.sellflow.sms.providers

/**
 * Nagad.
 *
 * Representative wording:
 *
 *   "You have received Tk 500.00 from 01712345678. Your Nagad balance Tk 3,200.00.
 *    TrxID: NG7A2B3C4D5"
 *
 * Nagad also confirms to the payer and states the transfer in the reverse order
 * on some handsets, so the receiver anchor is checked by the shared helpers
 * rather than assumed to be first.
 *
 * **Fixture provenance: REPRESENTATIVE / UNVERIFIED.** See
 * modules/sellflow-sms/fixtures/README.md.
 */
class NagadAdapter : AbstractProviderAdapter() {

    override val provider: Provider = Provider.NAGAD

    override val parserVersion: Int = 2

    override val transferAnchors: List<String> = listOf(
        "you have received",
        "you received",
        "received tk",
        "received bdt",
        "cash in",
        "payment received",
        "money received",
        "received money",
    )

    /**
     * `NAGAD` is the alphanumeric sender ID; `16167` is Nagad's published contact
     * shortcode. Same reasoning and same limits as [BkashAdapter.senderIdentities]:
     * an address missing from here still works when the body is branded, and a
     * match here still has to clear the receive verb, the OTP guard and the
     * amount and reference checks.
     */
    override val senderIdentities: Set<String> = setOf("NAGAD", "16167")

    private val BRAND = Regex("nagad", RegexOption.IGNORE_CASE)

    private val RECEIVED = Regex(
        "(you have received|you received|cash in|received|payment received|money received)",
        RegexOption.IGNORE_CASE,
    )

    private val SENT = Regex("you have sent|you sent|sent money|payment sent", RegexOption.IGNORE_CASE)

    /**
     * Money arriving, from Nagad.
     *
     * "Sent" is refused before the sender test, so recognising Nagad's address
     * can never let the payer's own confirmation count as the seller's receipt.
     * A receive verb is required on both paths, which is what stops a promotion
     * or a one-time passcode from this same address becoming a claimed message.
     * See [BkashAdapter.canHandle] for the full ordering rationale.
     */
    override fun canHandle(message: SmsMessage): Boolean {
        val text = message.messageBody
        if (MessageText.looksSuspicious(text)) return false
        if (SENT.containsMatchIn(text)) return false
        if (!RECEIVED.containsMatchIn(text)) return false
        return BRAND.containsMatchIn(text) || senderIsProvider(message)
    }
}