package com.sellflow.sms.providers

/**
 * bKash.
 *
 * One file per provider on purpose. bKash is the largest MFS in Bangladesh and
 * its wording is the one most likely to drift, so keeping it isolated means a
 * change to bKash's rules cannot silently alter how a Nagad message is read.
 *
 * Representative wording, documented here because it is the thing most likely to
 * need editing:
 *
 *   "You have received Tk 1,000.00 from 01712345678 on 12 Jan 2024 10:32 am.
 *    Your bKash balance Tk 15,000.00. TrxID: 8GHK9XYZ12A"
 *
 * **Fixture provenance: REPRESENTATIVE / UNVERIFIED.** See
 * modules/sellflow-sms/fixtures/README.md. The structure is the widely reported
 * one -- a receive verb, a currency amount, the paying number, the balance, and a
 * labelled TrxID -- but the exact wording is not publicly documented and must be
 * confirmed against a real captured message before release.
 */
class BkashAdapter : AbstractProviderAdapter() {

    override val provider: Provider = Provider.BKASH

    override val parserVersion: Int = 1

    /**
     * The receive verb, most specific first. bKash leads with the receipt, so
     * anchoring here is what separates the transfer from the balance that follows
     * it in the same message.
     */
    override val transferAnchors: List<String> = listOf(
        "you have received",
        "you received",
        "received tk",
        "received bdt",
        "cash in",
        "payment received",
        "money received",
    )

    /** The provider's own name, in the spellings that appear in these messages. */
    private val BRAND = Regex("b\\s*kash|bkash", RegexOption.IGNORE_CASE)

    /**
     * A receipt, not a request. bKash also sends "you have sent" messages to the
     * payer's handset; those describe money leaving, and accepting one would let
     * a sender's own confirmation stand in for the seller's receipt.
     */
    private val RECEIVED = Regex(
        "(you have received|you received|cash in|received|payment received|money received)",
        RegexOption.IGNORE_CASE,
    )

    private val SENT = Regex("you have sent|you sent|sent money|payment sent", RegexOption.IGNORE_CASE)

override fun canHandle(message: SmsMessage): Boolean {
        val text = message.messageBody
        if (MessageText.looksSuspicious(text)) return false
        if (!BRAND.containsMatchIn(text)) return false
        if (!RECEIVED.containsMatchIn(text)) return false
        if (SENT.containsMatchIn(text)) return false
        // Deliberately NOT checking for a currency token or an amount here.
        // `canHandle` answers "is this bKash's message?", and a bKash receipt with
        // no readable amount is still bKash's message -- it is just one this
        // adapter must refuse, with a reason that tells a developer whether the
        // amount or the wording is at fault. Folding validity into detection would
        // make every malformation look like "not a payment message".
        return true
    }
}