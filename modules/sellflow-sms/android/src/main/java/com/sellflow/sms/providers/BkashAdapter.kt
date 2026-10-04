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
 * **Detection reads the sender, because that is where bKash puts its name.**
 *
 * The wording above was originally the *only* thing detection had, and that was
 * the defect that lost a real payment. A production bKash receipt does not name
 * bKash in the body: bKash's own security guidance tells customers to check for
 * the transaction SMS "from bKash", which is the originating address, while the
 * body states only the receipt. So a real 65 BDT payment reached this module,
 * matched neither [BRAND] nor anything else, was refused as
 * `unsupported_provider`, and left the seller looking at a healthy screen with no
 * payment. Detection now accepts either signal -- the brand in the body, or an
 * address in [SENDER_IDENTITIES] -- and requires a receive verb in both cases.
 *
 * See `SenderIdentity` for why the sender test is a set lookup and not
 * `contains("bKash")`, and `fixtures/README.md` for the provenance of the corpus.
 */
class BkashAdapter : AbstractProviderAdapter() {

    override val provider: Provider = Provider.BKASH

    override val parserVersion: Int = 2

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

    /**
     * Originating addresses observed from bKash, normalised.
     *
     * `BKASH` is the alphanumeric sender ID, which bKash's own security guidance
     * names as the origin of its transaction SMS. `16247` is bKash's published
     * contact shortcode and is included because a payment confirmation has been
     * reported from it.
     *
     * Deliberately not exhaustive, and deliberately not load-bearing: these
     * addresses are not published as a complete list, so an address missing from
     * here still works as long as the operator branded the body. Adding one is a
     * one-line change and carries no parsing risk, because a match still has to
     * clear [RECEIVED], the OTP guard, and the amount and reference checks.
     */
    override val senderIdentities: Set<String> = setOf("BKASH", "16247")

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

    /**
     * Money arriving, from bKash.
     *
     * Checked in this order deliberately:
     *
     *  1. A body no payment notification looks like is out before anything else.
     *  2. A "sent" message is out before the sender test, so recognising bKash's
     *     address can never let the *payer's* own confirmation count as the
     *     seller's receipt. This is the check that keeps step 3 safe.
     *  3. A receive verb is required on both paths. This is the corroboration that
     *     makes a recognised sender sufficient to *claim* a message without being
     *     sufficient to *accept* one: bKash also sends OTPs, promotions and
     *     campaign blasts from this same address, and not one of those states a
     *     receipt.
     *  4. Either the body carries the brand, or the message came from a known
     *     bKash address.
     *
     * Deliberately NOT checking for a currency token or an amount here. `canHandle`
     * answers "is this bKash's message?", and a bKash receipt with no readable
     * amount is still bKash's message -- it is just one this adapter must refuse,
     * with a reason that tells a developer whether the amount or the wording is at
     * fault. Folding validity into detection would make every malformation look
     * like "not a payment message", which is how the original defect stayed
     * invisible.
     */
    override fun canHandle(message: SmsMessage): Boolean {
        val text = message.messageBody
        if (MessageText.looksSuspicious(text)) return false
        if (SENT.containsMatchIn(text)) return false
        if (!RECEIVED.containsMatchIn(text)) return false
        return BRAND.containsMatchIn(text) || senderIsProvider(message)
    }
}
