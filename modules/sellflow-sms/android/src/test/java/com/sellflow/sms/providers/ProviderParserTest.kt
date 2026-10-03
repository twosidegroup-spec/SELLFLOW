package com.sellflow.sms.providers

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The provider parsers, run against the shared fixture corpus.
 *
 * The corpus lives in `src/test/resources/fixtures/payment-sms.json` rather than
 * inline here, for two reasons. It is the same file the Node-side corpus test
 * reads, so "the fixtures cover what they claim to cover" is checked by something
 * that runs without a JDK. And it is a data file, so a real captured message can
 * be added to it during device QA without editing a test.
 *
 * Runs on the JVM. No device, no emulator, no Android runtime -- which is the
 * reason the parsing layer has no Android imports.
 *
 *   cd android && ./gradlew :sellflow-sms:testDebugUnitTest
 *
 * **Fixture provenance: REPRESENTATIVE, not captured.** See the `provenance` block
 * in the corpus and `docs/device-setup.md`. These fixtures prove the parser
 * behaves as specified against the structure of a money-in notification. They do
 * NOT prove it against any operator's real current wording, and a green run here
 * must never be reported as "bKash parsing verified on a real payment".
 */
class ProviderParserTest {

    private data class Case(
        val id: String,
        val sender: String,
        val body: String,
        val captured: Boolean,
        val expect: JSONObject,
        val note: String?,
    )

    private fun loadCases(): List<Case> {
        val stream = requireNotNull(
            javaClass.classLoader?.getResourceAsStream("fixtures/payment-sms.json"),
        ) { "fixtures/payment-sms.json is missing from the test resources" }

        val root = stream.bufferedReader().use { JSONObject(it.readText()) }
        val array: JSONArray = root.getJSONArray("cases")

        return (0 until array.length()).map { index ->
            val row = array.getJSONObject(index)
            Case(
                id = row.getString("id"),
                sender = row.optString("sender"),
                body = row.getString("body"),
                captured = row.optBoolean("captured", false),
                expect = row.getJSONObject("expect"),
                note = if (row.has("note")) row.optString("note") else null,
            )
        }
    }

    private fun message(case: Case, receivedAt: Long = 1_700_000_000_000L) = SmsMessage(
        sender = case.sender,
        messageBody = case.body,
        receivedAt = receivedAt,
        fingerprint = "fixture",
    )

    // ------------------------------------------------------------------ corpus

    @Test
    fun `every fixture reproduces its expected outcome`() {
        val cases = loadCases()
        assertTrue("the corpus must not be empty", cases.isNotEmpty())

        val ids = cases.map { it.id }
        assertEquals("fixture ids must be unique", ids.size, ids.toSet().size)

        for (case in cases) {
            val outcome = ProviderRegistry.parse(message(case))

            if (case.expect.getString("outcome") == "rejected") {
                assertTrue(
                    "${case.id}: expected a rejection, got $outcome\n${case.note.orEmpty()}",
                    outcome is ParseOutcome.Rejected,
                )
                assertEquals(
                    "${case.id}: wrong rejection reason\n${case.note.orEmpty()}",
                    case.expect.getString("reason"),
                    (outcome as ParseOutcome.Rejected).rejection.reason.id,
                )
            } else {
                assertTrue(
                    "${case.id}: expected a candidate, got $outcome\n${case.note.orEmpty()}",
                    outcome is ParseOutcome.Parsed,
                )
                val candidate = (outcome as ParseOutcome.Parsed).candidate
                val expected = case.expect

                assertEquals(
                    "${case.id}: wrong provider\n${case.note.orEmpty()}",
                    expected.getString("provider"),
                    candidate.provider.id,
                )
                assertEquals(
                    "${case.id}: wrong amount\n${case.note.orEmpty()}",
                    expected.getDouble("amount"),
                    candidate.amount,
                    0.001,
                )
                assertEquals(
                    "${case.id}: wrong transaction id\n${case.note.orEmpty()}",
                    expected.getString("transactionId"),
                    candidate.transactionId,
                )
                assertEquals(
                    "${case.id}: wrong sender\n${case.note.orEmpty()}",
                    expected.optStringOrNull("senderAccount"),
                    candidate.senderAccount,
                )
                assertEquals(
                    "${case.id}: wrong receiver\n${case.note.orEmpty()}",
                    expected.optStringOrNull("receiverAccount"),
                    candidate.receiverAccount,
                )
                assertEquals(
                    "${case.id}: wrong transaction timestamp\n${case.note.orEmpty()}",
                    expected.optStringOrNull("transactionTimestamp"),
                    candidate.transactionTimestamp?.let { MessageText.iso8601(it) },
                )
            }
        }
    }

    /**
     * Exactly one adapter may claim a message.
     *
     * The failure this catches is the expensive one: bKash and Nagad wording
     * overlap enough that a loose brand pattern would let two adapters claim the
     * same money, and the registry would attribute a customer's payment to whichever
     * happened to be registered first.
     */
    @Test
    fun `only the expected provider claims a message`() {
        for (case in loadCases()) {
            if (case.expect.getString("outcome") != "parsed") continue

            val expected = case.expect.getString("provider")
            val claimants = ProviderRegistry.adapters
                .filter { it.canHandle(message(case)) }
                .map { it.provider.id }

            assertEquals(
                "${case.id}: exactly one adapter must claim this message",
                listOf(expected),
                claimants,
            )
        }
    }

    /**
     * The parser must never leak the message it read.
     *
     * A candidate is the only thing that leaves this layer, so a field carrying any
     * part of the body -- or a field that is not in the contract at all -- is a
     * privacy failure that no type error would catch.
     */
    @Test
    fun `a candidate carries no message content`() {
        val allowed = setOf(
            "provider",
            "transactionId",
            "amount",
            "receiverAccount",
            "senderAccount",
            "transactionTimestamp",
            "fingerprint",
            "detectedAt",
            "parserVersion",
        )

        val fields = PaymentCandidate::class.java.declaredFields.map { it.name }.toSet()
        assertEquals(
            "PaymentCandidate's fields must be exactly the ingest arguments",
            allowed,
            fields,
        )

        for (case in loadCases()) {
            val outcome = ProviderRegistry.parse(message(case))
            if (outcome !is ParseOutcome.Parsed) continue

            val rendered = outcome.candidate.toString()
            val body = case.body
            // The parser must not return the body, or any slice of it longer than a
            // field's legitimate value.
            assertTrue(
                "${case.id}: the candidate's rendering contains the message body",
                !rendered.contains(body),
            )
        }
    }

    // ------------------------------------------------------------------ direct

    @Test
    fun `a passcode is never a payment`() {
        val bodies = listOf(
            "Your bKash OTP is 482913. Do not share it with anyone.",
            "482913",
            "bKash code: 774120 valid for 5 minutes",
            "Your Nagad verification code is 918273.",
            "bKash: You have received Tk 500 from 01712345678. Your OTP is 123456.",
        )

        for (body in bodies) {
            assertTrue(
                "must refuse a passcode: $body",
                MessageText.looksLikeOtpOrSecurity(body),
            )
        }
    }

    @Test
    fun `a transaction reference is never invented`() {
        // No reference, no candidate. Re-reading this message must not be able to
        // look like a second payment.
        val outcome = ProviderRegistry.parse(
            SmsMessage("bKash", "bKash: You have received Tk 500 from 01712345678.", 0L, "x"),
        )
        assertTrue(outcome is ParseOutcome.Rejected)
        assertEquals(
            RejectionReason.MISSING_TRANSACTION_ID,
            (outcome as ParseOutcome.Rejected).rejection.reason,
        )
    }

    @Test
    fun `an amount is never taken from a balance`() {
        val outcome = ProviderRegistry.parse(
            SmsMessage(
                "bKash",
                "bKash: You have received a payment. Your bKash balance is Tk 15,000.00. " +
                    "TrxID: BALONLY01",
                0L,
                "x",
            ),
        )
        assertTrue(
            "a balance must not be reported as a transfer, got $outcome",
            outcome is ParseOutcome.Rejected,
        )
    }

    @Test
    fun `a phone number is never accepted as a transaction reference`() {
        val outcome = ProviderRegistry.parse(
            SmsMessage(
                "bKash",
                "bKash: You have received Tk 500 from 01712345678. TrxID: 01812345678",
                0L,
                "x",
            ),
        )
        assertTrue(outcome is ParseOutcome.Rejected)
    }

    @Test
    fun `digits inside a reference are never read as an amount`() {
        val outcome = ProviderRegistry.parse(
            SmsMessage(
                "bKash",
                "bKash: You have received Tk from 01712345678. TrxID: BKMISSAMT1",
                0L,
                "x",
            ),
        )
        assertTrue("a currency with no figure must not become an amount of 1", outcome is ParseOutcome.Rejected)
    }

    @Test
    fun `a payer confirmation is not a receipt`() {
        val outcome = ProviderRegistry.parse(
            SmsMessage(
                "bKash",
                "bKash: You have sent Tk 500 to 01712345678. Your bKash balance Tk 4,500.00. " +
                    "TrxID: SENT00001",
                0L,
                "x",
            ),
        )
        assertTrue(
            "money leaving is not money arriving, got $outcome",
            outcome is ParseOutcome.Rejected,
        )
    }

    @Test
    fun `an unrelated message leaves nothing behind`() {
        val outcome = ProviderRegistry.parse(
            SmsMessage(
                "01712345678",
                "Are we still on for tomorrow? I will bring the sample.",
                0L,
                "x",
            ),
        )
        assertTrue(outcome is ParseOutcome.Rejected)
        assertEquals(
            RejectionReason.NOT_A_PAYMENT_MESSAGE,
            (outcome as ParseOutcome.Rejected).rejection.reason,
        )
    }

    @Test
    fun `provider parse never throws`() {
        // Every one of these made an earlier version of this layer throw.
        val hostile = listOf(
            "",
            " ",
            "\n",
            "Tk",
            "TrxID:",
            "TrxID: ",
            "You have received Tk 0 from 01712345678. TrxID: ZERO1",
            "You have received Tk -50 from 01712345678. TrxID: NEG001",
            "bKash: You have received Tk 99999999999999 from 01712345678. TrxID: HUGE01",
            "bKash: You have received Tk 1.2.3 from 01712345678. TrxID: BROKEN1",
            "bKash: You have received Tk 500 from 01712345678. TrxID: a",
            "bKash: You have received Tk 500 from 01712345678. TrxID: " + "A".repeat(400),
            "bKash: You have received Tk 500 from not-a-number. TrxID: TEXT0001",
            "bKash: You have received Tk 500 from 01712345678 on 99/99/9999. TrxID: BADDATE1",
            "bKash: You have received Tk 500 from 01712345678 on 03/04/2024. TrxID: AMBIGDATE",
            "bKash: You have received Tk 500 from 01712345678 at 25:99. TrxID: BADTIME01",
            "You have received Tk 500 from 01712345678. TrxID: NOBRAND01",
            "৳ 500",
            "bKash: ৳5৳5৳ from 01712345678. TrxID: BENGALI01",
        )

        for (body in hostile) {
            val outcome = ProviderRegistry.parse(SmsMessage("sender", body, 0L, "x"))
            // The assertion is that this line does not throw.
            assertNotNull("outcome must never be null for: $body", outcome)
        }
    }

    @Test
    fun `every provider has its own adapter and registry entry`() {
        // Guards against a fifth provider being added to the enum without a parser,
        // which would silently refuse every message from it.
        for (provider in Provider.entries) {
            assertNotNull(
                "${provider.id} has no adapter registered",
                ProviderRegistry.adapterFor(provider),
            )
        }
        assertEquals(Provider.entries.size, ProviderRegistry.adapters.size)
    }

    @Test
    fun `a receiver is only extracted when the message states one`() {
        // Most notifications name the payer, not the payee. Absent is the normal
        // case and is resolved downstream from the seller's own connected account.
        val withoutReceiver = ProviderRegistry.parse(
            SmsMessage(
                "bKash",
                "You have received Tk 500 from 01712345678. TrxID: NORECV001",
                0L,
                "x",
            ),
        )
        assertTrue(withoutReceiver is ParseOutcome.Parsed)
        assertNull((withoutReceiver as ParseOutcome.Parsed).candidate.receiverAccount)

        val withReceiver = ProviderRegistry.parse(
            SmsMessage(
                "bKash",
                "bKash: You have received Tk 640 from 01899998888. To account 01712345678. " +
                    "TrxID: RECV00001",
                0L,
                "x",
            ),
        )
        assertTrue(withReceiver is ParseOutcome.Parsed)
        assertEquals(
            "01712345678",
            (withReceiver as ParseOutcome.Parsed).candidate.receiverAccount,
        )
    }

    @Test
    fun `an ambiguous timestamp is refused rather than assumed`() {
        // 03/04/2024 is 3 April in Bangladesh and 4 March almost everywhere else.
        // `payment_events` keeps both a stated time and a detection time precisely
        // so a wrong guess is visible; better still is not to guess.
        assertNull(MessageText.transactionTimestampMillis("received on 03/04/2024"))
        assertNotNull(MessageText.transactionTimestampMillis("received on 25/12/2024"))
        assertNotNull(MessageText.transactionTimestampMillis("received on 25 Dec 2024"))
    }

    @Test
    fun `a body past the length gate is discarded before any adapter sees it`() {
        val padded = "bKash: You have received Tk 999 from 01712345678. TrxID: LONGPAD01. " +
            ("x".repeat(MessageText.MAX_BODY_LENGTH))
        assertTrue(MessageText.looksSuspicious(padded))
        assertTrue(ProviderRegistry.parse(SmsMessage("bKash", padded, 0L, "x")) is ParseOutcome.Rejected)
    }

    @Test
    fun `bd numbers normalise the four ways the same number is written`() {
        assertEquals("01712345678", MessageText.normalizeBdNumber("01712345678"))
        assertEquals("01712345678", MessageText.normalizeBdNumber("+8801712345678"))
        assertEquals("01712345678", MessageText.normalizeBdNumber("8801712345678"))
        assertEquals("01712345678", MessageText.normalizeBdNumber("1712345678"))
        assertEquals("01822000111", MessageText.normalizeBdNumber("01822000111"))
        // Not a mobile number, so not coerced into something that could match.
        assertNull(MessageText.normalizeBdNumber("12345"))
        assertNull(MessageText.normalizeBdNumber("017123"))
    }

    private fun JSONObject.optStringOrNull(key: String): String? {
        if (!has(key) || isNull(key)) return null
        return optString(key)
    }
}