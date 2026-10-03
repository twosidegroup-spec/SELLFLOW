package com.sellflow.sms.providers

/**
 * Provider detection.
 *
 * The listener asks this registry "is any of your providers this message?", and
 * the registry answers with at most one candidate or one counted refusal. It is
 * the only place that decides which parser runs, so a new provider is registered
 * here and nowhere else.
 *
 * Order matters in exactly one case. If two adapters both recognise a message --
 * a provider that rebrands, or a message quoting another provider -- the first
 * registered wins rather than the best-scoring one. There is no scoring here on
 * purpose: a tie-break that silently changes which provider is attributed to a
 * customer's money is not a decision anyone should make for a seller, and the
 * server re-checks provider against the connected account anyway.
 */
object ProviderRegistry {

    /**
     * The four adapters, in fixed order.
     *
     * Public for the JUnit suite and the diagnostics screen, which must enumerate
     * exactly what ships rather than a hard-coded copy of the list.
     */
    val adapters: List<ProviderAdapter> = listOf(
        BkashAdapter(),
        NagadAdapter(),
        RocketAdapter(),
        UpayAdapter(),
    )

    fun adapterFor(provider: Provider): ProviderAdapter? =
        adapters.firstOrNull { it.provider == provider }

    /**
     * The one adapter that claims this message, or null.
     *
     * Null means "not ours": an unrelated personal message, a marketing blast, a
     * code, or a bank that is not one of the four. Those are discarded without a
     * candidate and without their text being retained anywhere.
     */
    fun detect(message: SmsMessage): ProviderAdapter? =
        adapters.firstOrNull { it.canHandle(message) }

    /**
     * The end-to-end entry point the receiver calls.
     *
     * Never throws: a parse failure must not take down the broadcast, because a
     * crashed receiver loses the payment silently and the seller has no way to
     * find out. An unexpected failure is counted as a rejection instead.
     */
    fun parse(message: SmsMessage): ParseOutcome {
        // The two gates that belong to nobody in particular, checked before any
        // provider sees the message.
        //
        // A passcode is the single most damaging thing this module could turn into
        // a ledger row, and it is worth refusing before provider detection so the
        // refusal is reported as a passcode rather than as "not a payment
        // message" -- a diagnostic a developer can act on.
        if (MessageText.looksSuspicious(message.messageBody)) {
            return ParseOutcome.Rejected(ParseRejection(RejectionReason.NOT_A_PAYMENT_MESSAGE))
        }
        if (MessageText.looksLikeOtpOrSecurity(message.messageBody)) {
            return ParseOutcome.Rejected(ParseRejection(RejectionReason.OTP_OR_SECURITY_MESSAGE))
        }

        val adapter = detect(message)
            ?: return ParseOutcome.Rejected(
                ParseRejection(unclaimedReason(message.messageBody)),
            )

        return try {
            adapter.parse(message)
        } catch (error: RuntimeException) {
            // The message is not retained, not logged, and not attached to the
            // exception. A count is enough: the seller needs to know the listener
            // saw something it could not read, not what it said.
            ParseOutcome.Rejected(ParseRejection(RejectionReason.AMBIGUOUS_FIELDS))
        }
    }

    /**
     * Distinguishes "not one of ours" from "one of ours, but not one we read".
     *
     * A message that states a received amount in a currency and nobody recognised is
     * far more likely to be a payment from a provider SellFlow does not parse than a
     * marketing blast, and the two need different answers: the first means a parser
     * is missing, the second means the filter is working. Guessing which providers
     * exist would be guesswork; this is derived from the message itself.
     */
    private fun unclaimedReason(text: String): RejectionReason =
        if (MessageText.mentionsCurrency(text) && RECEIVE_VERB.containsMatchIn(text)) {
            RejectionReason.UNSUPPORTED_PROVIDER
        } else {
            RejectionReason.NOT_A_PAYMENT_MESSAGE
        }

    private val RECEIVE_VERB = Regex(
        "(received|credited|cash\\s*in|incoming|deposited|credited)",
        RegexOption.IGNORE_CASE,
    )
}