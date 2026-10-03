package com.sellflow.sms.providers

/** The four providers SellFlow recognises. Mirrors the `payment_provider` enum. */
enum class Provider(val id: String) {
    BKASH("bkash"),
    NAGAD("nagad"),
    ROCKET("rocket"),
    UPAY("upay");

    companion object {
        fun fromId(id: String): Provider? = entries.firstOrNull { it.id == id }
    }
}

/**
 * An inbound SMS as Android delivered it.
 *
 * [messageBody] lives only as long as one `parse` call. Nothing copies it onto a
 * candidate, onto disk, onto a queue row, into an event payload or into a log.
 * The contract in docs/sms-adapter-contract.md forbids storing the body, and this
 * type is where that holds: it is the only type that carries the text, and it
 * never leaves the parser.
 */
data class SmsMessage(
    val sender: String,
    val messageBody: String,
    val receivedAt: Long,
    /** SHA-256 hex of [messageBody]. Lets an identical redelivery be recognised. */
    val fingerprint: String,
)

/**
 * A normalised payment candidate: exactly the fields `ingest_payment_event`
 * needs, produced on-device before anything touches the network.
 *
 * Note what is NOT here: no raw body, no confidence score, no proposed order, no
 * payment status. A candidate asserts that a transfer happened. What it settles
 * is decided by the server and never by this layer.
 */
data class PaymentCandidate(
    val provider: Provider,
    /** Provider TrxID. Never invented: a message without one yields no candidate. */
    val transactionId: String,
    /** Transfer amount in whole taka, matching `numeric(14,2)` major units. */
    val amount: Double,
    /**
     * The receiving account exactly as the message stated it, or null when the
     * message does not state one.
     *
     * Null is a real and common case: most operators name the payer, not the
     * payee, because the payee is the person holding the phone. Null is resolved
     * on the JS side from the seller's own connected account rather than
     * invented here.
     */
    val receiverAccount: String?,
    /** The payer, or null when the message genuinely does not contain one. */
    val senderAccount: String?,
    /** When the provider says the transfer happened, or null when it did not say. */
    val transactionTimestamp: Long?,
    /** SHA-256 hex of the raw message. */
    val fingerprint: String,
    /** When the device saw the message, epoch milliseconds. */
    val detectedAt: Long,
    /** Bumped whenever a provider's rules change, so past events stay diagnosable. */
    val parserVersion: Int,
)

/** Why a message produced no candidate. Recorded as counts, never as text. */
enum class RejectionReason(val id: String) {
    NOT_A_PAYMENT_MESSAGE("not_a_payment_message"),
    OTP_OR_SECURITY_MESSAGE("otp_or_security_message"),

    /**
     * Reads as a received payment, but no adapter claimed it.
     *
     * Almost always a provider SellFlow does not parse yet. It is a separate reason
     * from [NOT_A_PAYMENT_MESSAGE] because the two need opposite responses: one
     * means a parser is missing, the other means the filter is doing its job.
     */
    UNSUPPORTED_PROVIDER("unsupported_provider"),

    MISSING_AMOUNT("missing_amount"),
    MALFORMED_AMOUNT("malformed_amount"),
    MISSING_TRANSACTION_ID("missing_transaction_id"),
    MALFORMED_TRANSACTION_ID("malformed_transaction_id"),
    AMBIGUOUS_FIELDS("ambiguous_fields"),

    /**
     * Retained because the contract enumerates it, not because the parser emits
     * it.
     *
     * There is deliberately no "missing receiver" refusal. A payment notification
     * names the payer, not the payee, so an absent receiving number is the normal
     * case rather than a defect; it is resolved on the JavaScript side from the
     * seller's own connected account and never invented here. Refusing would throw
     * away real payments on the majority of messages.
     */
    MISSING_RECEIVER_ACCOUNT("missing_receiver_account"),
}

/** Either a candidate or a counted refusal. Never both, never neither. */
sealed class ParseOutcome {
    data class Parsed(val candidate: PaymentCandidate) : ParseOutcome()
    data class Rejected(val reason: RejectionReason) : ParseOutcome()
}

/** The result of reading an amount, with enough detail to say why it failed. */
sealed class AmountRead {
    data class Found(val value: Double) : AmountRead()
    object Absent : AmountRead()
    object Malformed : AmountRead()
    object Ambiguous : AmountRead()
}

/**
 * One provider's parsing rules. The unit of extension.
 *
 * Adding a fifth MFS means writing one more implementation and registering it in
 * [ProviderRegistry]. The receiver, the candidate queue, the fingerprinting and
 * the JS bridge are untouched, which is what keeps four providers from becoming
 * one unreviewable parser.
 */
interface ProviderAdapter {
    /** Which provider this adapter speaks for. */
    val provider: Provider

    /**
     * Bumped whenever parsing behaviour changes in a way that could alter an
     * extracted field. Written onto every candidate so an event parsed today can
     * later be diagnosed against the rules that produced it. Starts at 1.
     */
    val parserVersion: Int

    /**
     * Whether this adapter recognises the message as its own.
     *
     * Cheap, and must not extract amounts: it answers "is this mine?", not "is
     * this valid?". Everything else is discarded before any parsing work starts,
     * so an unrelated message is never interpreted.
     */
    fun canHandle(message: SmsMessage): Boolean

    /**
     * Extracts a candidate, or explains the refusal.
     *
     * Called only for messages [canHandle] accepted, so it need not re-establish
     * that the message came from the right provider.
     */
    fun parse(message: SmsMessage): ParseOutcome

    /** Provider words that introduce the transfer amount rather than a balance. */
    val transferAnchors: List<String>
}

/**
 * The validation pipeline every adapter shares.
 *
 * Subclasses supply [canHandle], [transferAnchors] and their wording anchors; the
 * order of checks, the refusals and the shape of the result live here, so no
 * adapter can quietly skip the OTP guard or the plausibility test on a
 * transaction reference.
 */
abstract class AbstractProviderAdapter : ProviderAdapter {

    override fun parse(message: SmsMessage): ParseOutcome {
        val text = message.messageBody

        // First, always. An OTP is never a payment.
        if (MessageText.looksLikeOtpOrSecurity(text)) {
            return reject(RejectionReason.OTP_OR_SECURITY_MESSAGE)
        }

        val amount = when (val read = transferAmount(text)) {
            is AmountRead.Found -> read.value
            AmountRead.Absent -> return reject(RejectionReason.MISSING_AMOUNT)
            AmountRead.Malformed -> return reject(RejectionReason.MALFORMED_AMOUNT)
            AmountRead.Ambiguous -> return reject(RejectionReason.AMBIGUOUS_FIELDS)
        }

        val reference = MessageText.transactionReference(text)
            ?: return reject(
                if (MENTIONS_REFERENCE.containsMatchIn(text)) RejectionReason.MALFORMED_TRANSACTION_ID
                else RejectionReason.MISSING_TRANSACTION_ID,
            )

        if (!MessageText.isPlausibleTransactionReference(reference)) {
            return reject(RejectionReason.MALFORMED_TRANSACTION_ID)
        }

        return ParseOutcome.Parsed(
            PaymentCandidate(
                provider = provider,
                transactionId = reference,
                amount = amount,
                receiverAccount = MessageText.receiverAccount(text),
                senderAccount = MessageText.senderAccount(text),
                transactionTimestamp = MessageText.transactionTimestampMillis(text),
                fingerprint = message.fingerprint,
                detectedAt = message.receivedAt,
                parserVersion = parserVersion,
            ),
        )
    }

    /**
     * Reads the transfer amount, preferring this provider's own anchors.
     *
     * The anchor exists because a real notification states the transfer *and*
     * the resulting balance. Reading the balance instead of the transfer yields
     * plausible figures that silently match nothing, which is a failure a seller
     * experiences as "SellFlow never sees my payments".
     */
    protected open fun transferAmount(text: String): AmountRead {
        MessageText.anchoredAmount(text, transferAnchors)?.let { return AmountRead.Found(it) }

        if (MessageText.hasMalformedAmount(text)) return AmountRead.Malformed

        val remaining = MessageText.amountsExcludingBalances(text)
        if (remaining.size == 1) return AmountRead.Found(remaining[0])
        if (remaining.size > 1) return AmountRead.Ambiguous

        return if (MessageText.mentionsCurrency(text)) AmountRead.Malformed else AmountRead.Absent
    }

    protected fun reject(reason: RejectionReason): ParseOutcome.Rejected =
        ParseOutcome.Rejected(ParseRejection(reason))

    private companion object {
        /**
         * Word-guarded so a word that merely contains "ref" cannot turn a missing
         * reference into a malformed one.
         */
        val MENTIONS_REFERENCE = Regex(
            "(?<![A-Za-z])(?:trx\\s*-?\\s*id|transaction\\s*-?\\s*id|txn\\s*-?\\s*id|ref(?:erence)?\\b)",
            RegexOption.IGNORE_CASE,
        )
    }
}

/** A refusal plus the reason it happened, for counting without retaining text. */
data class ParseRejection(val reason: RejectionReason)