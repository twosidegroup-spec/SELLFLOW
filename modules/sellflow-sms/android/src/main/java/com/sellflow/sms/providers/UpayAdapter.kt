package com.sellflow.sms.providers

/**
 * Upay.
 *
 * Representative wording:
 *
 *   "You have received Tk 1,200.00 from 01912345678. Your Upay balance Tk 8,000.00.
 *    TrxID: UP99887766"
 *
 * Upay is the least documented of the four and has no `payment_method` value in
 * the ledger, so it records as `other` when it settles. It is included because a
 * seller taking money on Upay is real, not hypothetical.
 *
 * The brand pattern is deliberately tolerant of "U Pay", "UPAY" and "u-pay",
 * which are the spellings seen in the wild.
 *
 * **Fixture provenance: REPRESENTATIVE / UNVERIFIED.** See
 * modules/sellflow-sms/fixtures/README.md.
 */
class UpayAdapter : AbstractProviderAdapter() {

    override val provider: Provider = Provider.UPAY

    override val parserVersion: Int = 1

    override val transferAnchors: List<String> = listOf(
        "you have received",
        "you received",
        "received tk",
        "received bdt",
        "payment received",
        "money received",
        "cash in",
    )

    private val BRAND = Regex("u\\s*-?\\s*pay|upay", RegexOption.IGNORE_CASE)

    private val RECEIVED = Regex(
        "(you have received|you received|received|payment received|money received|cash in)",
        RegexOption.IGNORE_CASE,
    )

    private val SENT = Regex("you have sent|you sent|sent money|payment sent", RegexOption.IGNORE_CASE)

    override fun canHandle(message: SmsMessage): Boolean {
        val text = message.messageBody
        if (MessageText.looksSuspicious(text)) return false
        if (!BRAND.containsMatchIn(text)) return false
        if (!RECEIVED.containsMatchIn(text)) return false
        if (SENT.containsMatchIn(text)) return false
        return true
    }
}