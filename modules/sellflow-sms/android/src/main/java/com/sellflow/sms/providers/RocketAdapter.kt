package com.sellflow.sms.providers

/**
 * Rocket.
 *
 * Representative wording, in the two forms Rocket is reported to use:
 *
 *   "You have received Tk 300 from 01812345678. Your Rocket balance Tk 2,700.00.
 *    TrxID: RK1234567890"
 *
 *   "Cash In: Tk 300 from 01812345678 at 2024-01-12 22:15. TrxID: RK1234567890"
 *
 * The second form leads with "Cash In" instead of a sentence and puts the time
 * first, which is why the shared date parsing accepts both orderings and why the
 * amount anchor list here includes the bare "cash in" ahead of the longer
 * phrasings.
 *
 * **Fixture provenance: REPRESENTATIVE / UNVERIFIED.** See
 * modules/sellflow-sms/fixtures/README.md.
 */
class RocketAdapter : AbstractProviderAdapter() {

    override val provider: Provider = Provider.ROCKET

    override val parserVersion: Int = 2

    override val transferAnchors: List<String> = listOf(
        "you have received",
        "you received",
        "cash in",
        "cash-in",
        "received tk",
        "received bdt",
        "payment received",
    )

    /**
     * `ROCKET` is the alphanumeric sender ID; `16216` is Rocket's published contact
     * shortcode. Same reasoning and same limits as [BkashAdapter.senderIdentities].
     */
    override val senderIdentities: Set<String> = setOf("ROCKET", "16216")

    private val BRAND = Regex("rocket", RegexOption.IGNORE_CASE)

    private val RECEIVED = Regex(
        "(you have received|you received|cash in|cash-in|received|payment received)",
        RegexOption.IGNORE_CASE,
    )

    private val SENT = Regex("you have sent|you sent|cash out|cash-out|sent money", RegexOption.IGNORE_CASE)

    /**
     * Money arriving, from Rocket.
     *
     * "Cash out" is a withdrawal and is refused before the sender test, so
     * recognising Rocket's address can never let a cash-out confirmation count as
     * money arriving. A receive verb is required on both paths. See
     * [BkashAdapter.canHandle] for the full ordering rationale.
     */
    override fun canHandle(message: SmsMessage): Boolean {
        val text = message.messageBody
        if (MessageText.looksSuspicious(text)) return false
        if (SENT.containsMatchIn(text)) return false
        if (!RECEIVED.containsMatchIn(text)) return false
        return BRAND.containsMatchIn(text) || senderIsProvider(message)
    }
}