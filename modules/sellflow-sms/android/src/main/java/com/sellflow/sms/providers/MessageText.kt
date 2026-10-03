package com.sellflow.sms.providers

import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

/**
 * Pure string helpers shared by every provider adapter.
 *
 * No Android types and no I/O, deliberately: the whole parsing layer must be
 * exercisable by plain JVM unit tests without an emulator, because four
 * providers of provider-specific string handling is exactly the kind of code that
 * rots without tests.
 *
 * Three rules shape every function here.
 *
 * 1. **Extract by shape, not by position.** Operators reword and reorder these
 *    messages, so `text.substring(40)` is not a parser. Every extraction below is
 *    anchored to a label or a token shape.
 * 2. **Return null rather than guess.** A null makes the caller refuse the
 *    message. A guess produces a plausible wrong number, which is far more
 *    expensive: a wrong amount never matches an order, and a wrong TrxID lets one
 *    re-read of one message become two payments.
 * 3. **A balance is not an amount.** A real notification states the transfer
 *    *and* the resulting balance. Reading the wrong one yields plausible figures
 *    that silently never match anything, so the transfer is found by its anchor
 *    and a balance is excluded by its own.
 */
object MessageText {

    private val BD_MOBILE = Regex("^01[3-9]\\d{8}$")
    private val PLUS_880 = Regex("^8801[3-9]\\d{8}$")
    private val BARE_LOCAL = Regex("^1[3-9]\\d{8}$")

    /** `TrxID`, `Trx ID`, `Transaction ID`, `TxnId`, `Ref`, `Reference`. */
    private val TRX_LABEL = Regex(
        "(?:trx\\s*-?\\s*id|transaction\\s*-?\\s*id|txn\\s*-?\\s*id|ref(?:erence)?\\s*(?:no|number|id)?)" +
            "\\s*[:#-]?\\s*([A-Za-z0-9]{4,32})",
        RegexOption.IGNORE_CASE,
    )

    /**
     * A money amount: up to nine integer digits, optional thousands separators,
     * up to two decimals.
     *
     * The digit boundaries are lookarounds so `1000` never matches inside
     * `10001`, and the nine-digit ceiling means a phone number can never be read
     * as an amount even if a label sits next to one.
     */
    private val AMOUNT = Regex("(?<![\\d.,])(\\d{1,9}(?:,\\d{2,3})*(?:\\.\\d{1,2})?)(?![\\d])")

    /**
     * A currency token.
     *
     * Letter lookarounds rather than `\b`, because operators write `Tk1000` as
     * often as `Tk 1000` and `\bTk\b` silently misses the first.
     */
    private val CURRENCY = Regex(
        "(?<![A-Za-z])Tk\\.?(?![A-Za-z])|(?<![A-Za-z])taka(?![A-Za-z])|(?<![A-Za-z])BDT(?![A-Za-z])|৳",
        RegexOption.IGNORE_CASE,
    )

    private val DATE = Regex("\\b\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}\\b")

    /**
     * `12 Jan 2024`.
     *
     * A separate pattern rather than an alternative in [DATE] because the two are
     * genuinely different shapes, and folding them together would mean the amount
     * scanner had to reason about both.
     */
    private val ENGLISH_DATE = Regex("\\b\\d{1,2}\\s+[A-Za-z]{3}[a-z]*\\s+\\d{4}\\b")

    private val CLOCK = Regex("\\b\\d{1,2}:\\d{2}\\s*(?:am|pm)?\\b", RegexOption.IGNORE_CASE)

    /**
     * Label forms that introduce the receiving account.
     *
     * Letter lookarounds rather than a bare `to`, because `to` is a substring of
     * half the English language and a loose match here would read a digit run out
     * of an unrelated word.
     */
    private val RECEIVER_LABEL = Regex(
        "(?:(?<![A-Za-z])to\\b\\s*(?:account|a/c|no\\.?|number)?" +
            "|(?<![A-Za-z])your\\b\\s*account" +
            "|(?<![A-Za-z])a/c" +
            "|(?<![A-Za-z])account\\b\\s*(?:no\\.?|number)" +
            "|(?<![A-Za-z])receiv(?:er|ing)\\b" +
            "|(?<![A-Za-z])recipient\\b)" +
            "\\s*[:#-]?\\s*(\\+?\\d[\\d\\s-]{7,20}\\d)",
        RegexOption.IGNORE_CASE,
    )

    /** Label forms that introduce the paying number. */
    private val SENDER_LABEL = Regex(
        "(?:(?<![A-Za-z])from\\b|(?<![A-Za-z])sent\\s*by\\b|(?<![A-Za-z])payer\\b" +
            "|(?<![A-Za-z])sender\\b|(?<![A-Za-z])paid\\s*by\\b)" +
            "\\s*[:#-]?\\s*(\\+?\\d[\\d\\s-]{7,20}\\d)",
        RegexOption.IGNORE_CASE,
    )

    /**
     * Content that cannot be a payment notification.
     *
     * A payment message is short prose with a number in it. A very long body, a
     * body carrying control characters, or a body that is mostly digits is not a
     * payment, and parsing it would only produce noise the engine has to refuse
     * anyway.
     */
    private val CONTROL_CHARS = Regex("[\\p{Cntrl}&&[^\\r\\n\\t]]")

    /**
     * Beyond this a message is a broadcast, a concatenated SMS or a corrupted
     * payload rather than a payment notification.
     *
     * A single SMS part is at most 160 characters, and the payment notifications
     * this feature reads are well under that. 800 leaves generous room for a
     * multi-part body while still discarding anything that is obviously not a
     * transaction, and it runs before provider detection so a broadcast that embeds
     * a real-looking notification is never parsed.
     */
    const val MAX_BODY_LENGTH = 800

    /**
     * Words that mark a one-time passcode or a security message.
     *
     * Deliberately does NOT include a bare "code". A payment notification may
     * legitimately contain the word, and refusing every message that mentions it
     * would drop real payments. The labelled-number rule below catches the message
     * that actually matters -- "code: 774120" -- without the broad ban.
     */
    private val OTP_MARKERS = Regex(
        "\\b(otp|one[\\s-]?time\\s*(?:pin|password|code)|verification|verify\\s*code" +
            "|security\\s*code|auth\\s*code|passcode|2fa)\\b",
        RegexOption.IGNORE_CASE,
    )

    /** `code: 774120`, `PIN 1234`, `OTP - 9182` anywhere in the body. */
    private val LABELLED_SECRET = Regex(
        "(?:^|[^A-Za-z])(?:code|pin|otp|pass)\\s*[:#-]?\\s*(\\d{4,8})(?![\\d])",
        RegexOption.IGNORE_CASE,
    )

    /** Words that mark a running total rather than a transfer. */
    val BALANCE_WORDS = listOf(
        "balance", "available", "remaining", "current balance",
        "your total", "insufficient", "due", "outstanding",
    )

    /** How far past an anchor an amount may sit and still belong to it. */
    private const val ANCHOR_WINDOW = 60

    fun digitsOnly(raw: String): String = raw.filter { it.isDigit() }

    /**
     * Canonicalises a BD mobile number to `01XXXXXXXXX`.
     *
     * Mirrors `payment_normalize_bk_number` in migration 0022 so the two agree.
     * Anything not recognisably a BD mobile number returns null rather than a
     * coerced value that could match by accident.
     */
    fun normalizeBdNumber(raw: String): String? {
        val digits = digitsOnly(raw)
        return when {
            BD_MOBILE.matches(digits) -> digits
            PLUS_880.matches(digits) -> "0" + digits.substring(3)
            BARE_LOCAL.matches(digits) -> "0" + digits
            else -> null
        }
    }

    fun isBdMobile(raw: String): Boolean = normalizeBdNumber(raw) != null

    /**
     * Whether this is a one-time passcode or account-security message.
     *
     * Checked before any provider pattern. An OTP is never a payment, and the
     * single most damaging thing this module could do is turn someone's
     * two-factor code into a ledger row.
     */
    fun looksLikeOtpOrSecurity(text: String): Boolean {
        if (OTP_MARKERS.containsMatchIn(text)) return true
        if (LABELLED_SECRET.containsMatchIn(text)) return true
        val trimmed = text.trim()
        // A body that is only digits of passcode length is a code. A payment
        // notification always carries prose and a reference.
        if (trimmed.matches(Regex("[\\s\\d]{4,12}")) && digitsOnly(trimmed).length in 4..8) return true
        return false
    }

    fun mentionsCurrency(text: String): Boolean = CURRENCY.containsMatchIn(text)

    /**
     * Whether the body is something no payment notification ever looks like.
     *
     * The first gate, ahead of provider matching, so a broadcast or a corrupt
     * payload is never handed to an adapter at all.
     */
    fun looksSuspicious(text: String): Boolean {
        if (text.length > MAX_BODY_LENGTH) return true
        if (text.isBlank()) return true
        if (CONTROL_CHARS.containsMatchIn(text)) return true
        // A body that is mostly digits is a code, a balance ping or a USSD dump.
        val digits = digitsOnly(text).length
        return digits > text.length / 2 && text.length >= 12
    }

/**
 * The amount that follows any of [anchors], when they all agree.
 *
 * Each anchor is searched, and the first usable amount within [ANCHOR_WINDOW]
 * characters of it is taken. One distinct value across all anchors wins; two
 * distinct values means the message contradicts itself and the caller must refuse
 * rather than pick.
 *
 * Balance exclusion applies here too, which is the whole point of this function
 * existing separately from the bare amount scan. `You have received a payment. Your
 * bKash balance is Tk 15,000.00` has an amount inside the anchor window, and
 * without the exclusion that message reports a payment of 15,000 taka. Every
 * currency operator states a balance in the same message as a transfer, so reading
 * the wrong number is not an edge case here -- it is the normal case.
 */
fun anchoredAmount(
        text: String,
        anchors: List<String>,
        excludedWords: List<String> = BALANCE_WORDS,
    ): Double? {
        val excluded = balanceWindows(text, excludedWords)
        val values = LinkedHashSet<Double>()
        for (anchor in anchors) {
            val index = text.indexOf(anchor, ignoreCase = true)
            if (index < 0) continue
            val windowEnd = minOf(text.length, index + ANCHOR_WINDOW)
            val window = text.substring(index, windowEnd)
            // `excluded` is in absolute offsets and stays that way: converting it to
            // window offsets here looks right and is not, because the scan starts
            // `anchor.length` characters into the window rather than at its start.
            // That off-by-anchor-length bug let a balance sitting after the anchor
            // be reported as the transfer -- the exact failure this whole function
            // exists to prevent.
            val value = firstAmountIn(window, anchor.length, excluded) ?: continue
            values.add(value)
        }
        return if (values.size == 1) values.first() else null
    }

    /**
     * Every amount in the message that is not a running total.
     *
     * The caller decides what a list of several means. One value is the
     * transfer; two is ambiguity and must be refused rather than resolved by
     * picking the first, because guessing here produces an amount that never
     * matches an order and looks like a broken feature to the seller.
     */
    fun amountsExcludingBalances(
        text: String,
        excludedWords: List<String> = BALANCE_WORDS,
    ): List<Double> {
        val excluded = balanceWindows(text, excludedWords)

        val values = LinkedHashSet<Double>()
        for (match in AMOUNT.findAll(text)) {
            val start = match.range.first
            if (excluded.any { start in it }) continue
            if (isInsideDateOrClock(text, start)) continue
            if (!isMoneyToken(text, start, match.range.last)) continue
            val value = match.groupValues[1].replace(",", "").toDoubleOrNull() ?: continue
            if (value <= 0.0) continue
            values.add(value)
        }
        return values.toList()
    }

    /** Ranges covered by a running-total word, so amounts inside them are skipped. */
    private fun balanceWindows(
        text: String,
        excludedWords: List<String>,
    ): List<IntRange> {
        val excluded = ArrayList<IntRange>()
        for (word in excludedWords) {
            var from = 0
            while (true) {
                val index = text.indexOf(word, from, ignoreCase = true)
                if (index < 0) break
                excluded.add(index..minOf(text.length - 1, index + ANCHOR_WINDOW))
                from = index + word.length
            }
        }
        return excluded
    }

    /**
     * Whether a digit run is a number in its own right rather than part of a
     * reference.
     *
     * This is the rule that stops `TrxID: BKMISSAMT1` contributing an amount of 1
     * and `TrxID: 8GHK9XYZ12A` contributing 8 and 12. Without it, a malformed or
     * amount-less payment message quietly becomes a payment of the wrong size --
     * a plausible wrong number, which is the failure mode this whole layer exists
     * to avoid.
     *
     * A run is a number when it is not touching letters, with one exception:
     * `Tk1000` has no space and is extremely common, so a run whose preceding
     * letters are exactly a currency token is still a number.
     */
    private fun isMoneyToken(text: String, start: Int, end: Int): Boolean {
        val after = if (end + 1 < text.length) text[end + 1] else ' '
        if (after.isLetter()) return false

        val before = if (start - 1 >= 0) text[start - 1] else ' '
        if (!before.isLetter()) return true

        // Walk back over the letters and see whether they spell a currency token.
        var index = start - 1
        while (index >= 0 && text[index].isLetter()) index -= 1
        val letters = text.substring(index + 1, start)
        return letters.isNotEmpty() && CURRENCY.matches(letters)
    }

    /**
     * Whether a currency token is followed by something that is not an amount.
     *
     * Separates "no amount" from "a broken amount" so the diagnostics can tell a
     * marketing message from a truncated one.
     */
    fun hasMalformedAmount(text: String): Boolean {
        for (match in CURRENCY.findAll(text)) {
            val start = match.range.last + 1
            if (start >= text.length) return true
            val tail = text.substring(start, minOf(text.length, start + 24))
            val firstDigit = tail.indexOfFirst { it.isDigit() }
            if (firstDigit < 0) return true
            val candidate = tail.substring(firstDigit)
            val parsed = AMOUNT.find(candidate)
            if (parsed == null || parsed.range.first != 0) return true
        }
        return false
    }

    /**
     * The provider's transaction reference.
     *
     * A labelled reference is preferred. Failing that, an unlabelled token counts
     * only when it is unmistakably a reference: alphanumeric, contains a digit,
     * not a phone number, not a date or a clock.
     *
     * Nothing is synthesised. A message with no recoverable reference yields
     * null, so the caller declines it, because re-reading one SMS must never
     * look like a second payment.
     */
    fun transactionReference(text: String): String? {
        TRX_LABEL.find(text)?.let { match ->
            val value = match.groupValues[1]
            if (isPlausibleTransactionReference(value)) return value
        }

        for (token in text.split(Regex("[^A-Za-z0-9]+"))) {
            val candidate = token.trim()
            if (!isPlausibleTransactionReference(candidate)) continue
            if (candidate.all { it.isDigit() && candidate.length >= 10 }) continue
            if (candidate.all { it.isLetter() }) continue
            return candidate
        }
        return null
    }

    /** Whether a reference is shaped like one, so a malformed label is refused. */
    fun isPlausibleTransactionReference(raw: String): Boolean {
        val value = raw.trim()
        if (value.length !in 4..32) return false
        if (!value.all { it.isLetterOrDigit() }) return false
        if (value.none { it.isDigit() }) return false
        if (isBdMobile(value)) return false
        if (DATE.matches(value) || CLOCK.matches(value)) return false
        return true
    }

    /** The receiving account, when the message states it. Otherwise null. */
    fun receiverAccount(text: String): String? =
        RECEIVER_LABEL.find(text)?.groupValues?.get(1)?.let { normalizeBdNumber(it) }

    /** The paying number, when the message states it. Otherwise null. */
    fun senderAccount(text: String): String? =
        SENDER_LABEL.find(text)?.groupValues?.get(1)?.let { normalizeBdNumber(it) }

    /**
     * The transfer time the provider stated, or null.
     *
     * Parsed as Asia/Dhaka without the platform time-zone database, because both
     * observed orderings are unambiguous: `12 Jan 2024 10:32 am` and
     * `10:32 pm, 12/01/2024`. Anything else is left null rather than guessed, and
     * the server then falls back to its own detection time — the gap between the
     * two is itself a signal, and the column records both.
     */
    fun transactionTimestampMillis(text: String): Long? {
        val date = DATE.find(text)?.value ?: ENGLISH_DATE.find(text)?.value ?: return null
        val clock = CLOCK.find(text)?.value ?: return null
        val time = parseClock(clock) ?: return null
        val day = parseDate(date) ?: return null

        val calendar = Calendar.getInstance(TimeZone.getTimeZone("Asia/Dhaka"))
        calendar.clear()
        calendar.set(
            day[0],
            day[1] - 1,
            day[2],
            if (time[2]) (time[0] % 12) + 12 else time[0],
            time[1],
            0,
        )
        return calendar.timeInMillis
    }

    /** ISO 8601 with offset, which is what the ingest RPC's timestamptz wants. */
    fun iso8601(epochMillis: Long): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.ROOT).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(java.util.Date(epochMillis))

    // ---------------------------------------------------------------- internals

    /**
     * The first usable amount after [skipIndex] characters of [window].
     *
     * [excluded] is in ABSOLUTE offsets into the whole message, and matches are
     * translated before being compared, because the caller scans a slice of the
     * message rather than the whole of it.
     */
private fun firstAmountIn(
        window: String,
        skipIndex: Int,
        excluded: List<IntRange>,
    ): Double? {
        val tail = window.substring(minOf(skipIndex, window.length))
        for (match in AMOUNT.findAll(tail)) {
            val absolute = match.range.first + skipIndex
            if (excluded.any { absolute in it }) continue
            if (isInsideDateOrClock(window, absolute)) continue
            if (!isMoneyToken(tail, match.range.first, match.range.last)) continue
            val value = match.groupValues[1].replace(",", "").toDoubleOrNull() ?: continue
            if (value > 0.0) return value
        }
        return null
    }

    private fun isInsideDateOrClock(text: String, index: Int): Boolean {
        val start = maxOf(0, index - 8)
        val end = minOf(text.length, index + 8)
        val window = text.substring(start, end)
        return CLOCK.containsMatchIn(window) || DATE.containsMatchIn(window)
    }

    private fun parseClock(raw: String): Triple<Int, Int, Boolean>? {
        val match = Regex("(\\d{1,2}):(\\d{2})\\s*(am|pm)?", RegexOption.IGNORE_CASE)
            .find(raw.trim()) ?: return null
        val hour = match.groupValues[1].toIntOrNull() ?: return null
        val minute = match.groupValues[2].toIntOrNull() ?: return null
        if (hour !in 0..23 || minute !in 0..59) return null
        return Triple(hour, minute, match.groupValues[3].equals("pm", ignoreCase = true))
    }

    /**
     * Splits a date into year, month, day.
     *
     * Accepts `12/01/2024`, `12-01-2024` and `12 Jan 2024`. Two-digit years are
     * read from 2000. A fully ambiguous `03/04/2024` is refused rather than
     * resolved, because a day-first reading is an assumption and a wrong
     * timestamp is a wrong intent window.
     */
    private fun parseDate(raw: String): Triple<Int, Int, Int>? {
        val numeric = Regex("^(\\d{1,2})[/-](\\d{1,2})[/-](\\d{2,4})$").find(raw) ?: return english(raw)
        val first = numeric.groupValues[1].toIntOrNull() ?: return null
        val second = numeric.groupValues[2].toIntOrNull() ?: return null
        val year = expandYear(numeric.groupValues[3].toIntOrNull() ?: return null)
        if (first !in 1..31 || second !in 1..31) return null
        if (first > 12 && second <= 12) return Triple(year, second, first)
        if (second > 12 && first <= 12) return Triple(year, first, second)
        return null
    }

    private fun english(raw: String): Triple<Int, Int, Int>? {
        val months = listOf(
            "jan", "feb", "mar", "apr", "may", "jun",
            "jul", "aug", "sep", "oct", "nov", "dec",
        )
        val match = Regex("^(\\d{1,2})\\s+([A-Za-z]{3})[a-z]*\\s+(\\d{2,4})$").find(raw) ?: return null
        val day = match.groupValues[1].toIntOrNull() ?: return null
        if (day !in 1..31) return null
        val month = months.indexOf(match.groupValues[2].lowercase(Locale.ROOT))
        if (month < 0) return null
        val year = expandYear(match.groupValues[3].toIntOrNull() ?: return null)
        return Triple(year, month + 1, day)
    }

    private fun expandYear(raw: Int): Int = if (raw < 100) 2000 + raw else raw
}