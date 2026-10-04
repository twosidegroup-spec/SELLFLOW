package com.sellflow.sms.providers

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
 * **Fixture provenance is MIXED.** See the `provenance` block in the corpus. Most
 * cases are representative; the `bkash-real-*` cases are structures taken from a
 * real 65 BDT payment that this app received and refused, with the transaction
 * reference redacted. The rule for reading a green run here: it proves the parser
 * behaves as specified against structures that include the one that actually
 * failed, and it proves nothing at all about an operator's wording tomorrow. A
 * green run must never be reported as "bKash parsing verified on a real payment"
 * unless a real payment on a real handset actually completed the whole chain.
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
                    (outcome as ParseOutcome.Rejected).reason.id,
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
            (outcome as ParseOutcome.Rejected).reason,
        )
    }

/**
     * REGRESSION: a balance-only message must never become a 15,000 taka payment.
     *
     * This is the defect found during Phase 2 review, pinned here by name because
     * it is the single most dangerous failure mode in this layer.
     *
     * Every currency operator states the resulting balance in the same message as
     * the transfer, so the number that follows the receive verb is not necessarily
     * the money that arrived. An earlier version of `anchoredAmount` converted
     * balance windows to window-relative offsets but compared them against
     * tail-relative match positions -- off by `anchor.length` -- so the exclusion
     * never applied and this exact message was accepted as a payment of 15,000.
     *
     * If this test ever fails, do not widen the tolerance to make it pass. The
     * whole point is that an amount the message never stated as a transfer must
     * not reach the ledger.
     */
    @Test
    fun `REGRESSION a balance of 15000 is never reported as a payment of 15000`() {
        // Two distinct situations, and the property is the same for both: the
        // figure 15,000 appears in these messages ONLY as a balance.
        val balanceOnly = listOf(
            "bKash: You have received a payment. Your bKash balance is Tk 15,000.00. " +
                "TrxID: BALONLY01",
            "Nagad: You have received a payment. Your Nagad balance BDT 15,000.00. " +
                "TrxID: BALONLY03",
        )

        // No transfer figure is stated, so there is nothing to parse. These must be
        // refused outright.
        for (body in balanceOnly) {
            val outcome = ProviderRegistry.parse(SmsMessage("provider", body, 0L, "x"))
            assertTrue(
                "a balance-only message must not produce a candidate, got $outcome\n  from: $body",
                outcome is ParseOutcome.Rejected,
            )
        }

        // A real transfer alongside the balance is a different message: it must
        // parse, and it must report the transfer. The assertion that matters is the
        // same either way -- 15,000 is never the answer.
        val withTransfer =
            "bKash: You have received Tk 500 from 01812345678. Your bKash balance is Tk " +
                "15,000.00. TrxID: BALONLY02"

        val parsed = ProviderRegistry.parse(SmsMessage("provider", withTransfer, 0L, "x"))
        assertTrue(
            "a stated transfer must still parse, got $parsed",
            parsed is ParseOutcome.Parsed,
        )
        assertNotEquals(
            "the balance of 15,000 was reported as the transfer",
            15_000.0,
            (parsed as ParseOutcome.Parsed).candidate.amount,
            0.001,
        )
    }

    /**
     * The same rule from the other side: when a message states BOTH a transfer and
     * a balance, the number that comes back is the transfer.
     */
    @Test
    fun `the transfer is reported, not the balance, when both are stated`() {
        val outcome = ProviderRegistry.parse(
            SmsMessage(
                "bKash",
                "bKash: You have received Tk 1,000.00 from 01812345678. " +
                    "Your bKash balance Tk 15,000.00. TrxID: BOTHTX001",
                0L,
                "x",
            ),
        )

        assertTrue("expected a candidate, got $outcome", outcome is ParseOutcome.Parsed)
        assertEquals(
            "must be the transfer, never the balance",
            1000.0,
            (outcome as ParseOutcome.Parsed).candidate.amount,
            0.001,
        )
    }

    @Test
    fun `an insufficient funds notice is not a payment`() {
        // Money the seller does NOT have. Accepting this would credit a payment
        // that never happened, from a message that only mentions a number.
        val bodies = listOf(
            "bKash: You have insufficient balance. You need Tk 500 more. " +
                "Your bKash balance Tk 300.00",
            "Nagad: Insufficient balance. Please deposit Tk 1,000 to continue.",
        )

        for (body in bodies) {
            assertTrue(
                "an insufficient-funds notice is not a payment: $body",
                ProviderRegistry.parse(SmsMessage("provider", body, 0L, "x"))
                    is ParseOutcome.Rejected,
            )
        }
    }

    @Test
    fun `a cash-out notice is not an incoming payment`() {
        // Cash in is money arriving and is supported -- `rocket-cash-in-leading` in
        // the corpus covers it. Cash out is money leaving, and must never settle an
        // order: the seller's own withdrawal would be credited as a customer's
        // payment.
        val outcome = ProviderRegistry.parse(
            SmsMessage(
                "Rocket",
                "Rocket: You have cash out Tk 500 to 01812345678. " +
                    "Your Rocket balance Tk 2,200.00. TrxID: RKCASHOT1",
                0L,
                "x",
            ),
        )
        assertTrue("cash out must not parse as a payment, got $outcome", outcome is ParseOutcome.Rejected)
    }

    @Test
    fun `a transaction id that is too short to identify a payment is refused`() {
        // The database requires four characters. Below that a reference cannot
        // identify a transaction, and re-reading the same SMS would look like a
        // second payment.
        for (reference in listOf("a", "ab", "abc")) {
            val outcome = ProviderRegistry.parse(
                SmsMessage(
                    "bKash",
                    "bKash: You have received Tk 500 from 01712345678. TrxID: $reference",
                    0L,
                    "x",
                ),
            )
            assertTrue(
                "a '$reference' reference must be refused, got $outcome",
                outcome is ParseOutcome.Rejected,
            )
            assertEquals(
                RejectionReason.MALFORMED_TRANSACTION_ID,
                (outcome as ParseOutcome.Rejected).reason,
            )
        }
    }

    @Test
    fun `a zero or negative amount never becomes a payment`() {
        val bodies = listOf(
            "bKash: You have received Tk 0 from 01712345678. TrxID: ZEROAMT01",
            "bKash: You have received Tk -500 from 01712345678. TrxID: NEGAMT001",
        )

        for (body in bodies) {
            val outcome = ProviderRegistry.parse(SmsMessage("provider", body, 0L, "x"))
            assertTrue(
                "a zero or negative amount must not become a payment, got $outcome",
                outcome is ParseOutcome.Rejected,
            )
        }
    }

    @Test
    fun `a negative amount is never read as its absolute value`() {
        // "Tk -500" must not become a payment of 500. Found by adversarial
        // testing: the sign is not part of an amount match, so it has to be
        // excluded explicitly.
        val outcome = ProviderRegistry.parse(
            SmsMessage(
                "bKash",
                "bKash: You have received Tk -500 from 01712345678. TrxID: NEGAMT002",
                0L,
                "x",
            ),
        )

        if (outcome is ParseOutcome.Parsed) {
            assertNotEquals(
                "a negative amount was read as a positive transfer",
                500.0,
                outcome.candidate.amount,
                0.001,
            )
        }
    }

    @Test
    fun `non-ascii digits fail closed rather than being coerced`() {
        // Bengali numerals. `Char.isDigit()` accepts them, so they can survive into
        // a digit count -- but Java's `\d` is ASCII-only, so they must not become
        // an amount. Fail-closed is the only acceptable outcome: coercing these
        // would be a guess about a number that was never read.
        val bodies = listOf(
            "bKash: You have received Tk ১০০০ from 01712345678. TrxID: BENGALI01",
            "bKash: You have received Tk १००० from 01712345678. TrxID: DEVANAG01",
        )

        for (body in bodies) {
            val outcome = ProviderRegistry.parse(SmsMessage("provider", body, 0L, "x"))
            assertTrue(
                "non-ascii digits must not produce an amount, got $outcome",
                outcome is ParseOutcome.Rejected,
            )
        }
    }

    @Test
    fun `markup never reaches a candidate`() {
        // A message containing HTML-ish text may well parse -- the fields are all
        // present, and refusing it would be a false negative on a real notification
        // that happened to contain an ampersand. The property that actually matters
        // is that no extracted field carries the markup, and that nothing outside
        // the normalised contract is produced.
        val bodies = listOf(
            "<b>bKash</b>: You have received Tk 500 from 01712345678. TrxID: HTML001",
            "bKash: You have received Tk 500 from 01712345678. " +
                "<script>alert(1)</script> TrxID: HTML002",
            "bKash &amp; Co: You have received Tk 500 from 01712345678. TrxID: HTML003",
        )

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

        for (body in bodies) {
            val outcome = ProviderRegistry.parse(SmsMessage("provider", body, 0L, "x"))
            if (outcome !is ParseOutcome.Parsed) continue

            val candidate = outcome.candidate

            assertEquals(
                "a candidate must carry only the normalised contract",
                allowed,
                PaymentCandidate::class.java.declaredFields.map { it.name }.toSet(),
            )

            val rendered = candidate.toString()
            for (fragment in listOf("<b>", "</b>", "<script>", "alert(1)", "&amp;")) {
                assertTrue(
                    "markup '$fragment' leaked into a candidate: $rendered",
                    !rendered.contains(fragment),
                )
            }
        }
    }

    @Test
    fun `a real bKash receipt is detected from its sender, not a brand word`() {
        // THE REGRESSION. This is the shape of a real 65 BDT payment that arrived on
        // a seller's handset, was delivered to the receiver, and was refused -- while
        // all 27 tests in this suite passed.
        //
        // Two things were wrong with the detection rule, and both are visible in the
        // fixture corpus rather than in any assertion here:
        //
        //   1. bKash does not put its name in the body. bKash's own security guidance
        //      tells customers the transaction SMS comes FROM bKash, which is the
        //      originating address. The body is a bare receipt naming the payer.
        //   2. The amount is written Tk65.00, with no space after the currency token.
        //
        // Detection used to require the brand word in the body, so this message was
        // refused as `unsupported_provider` and the seller saw a healthy screen and
        // no payment. It is now claimed from the originating address.
        val outcome = ProviderRegistry.parse(
            SmsMessage(
                "bKash",
                "You have received Tk65.00 from 01712345678. TrxID: 9REAL0650AA",
                1_700_000_000_000L,
                "x",
            ),
        )

        assertTrue(
            "a real bKash receipt must be detected, got $outcome",
            outcome is ParseOutcome.Parsed,
        )
        val candidate = (outcome as ParseOutcome.Parsed).candidate
        assertEquals("bkash", candidate.provider.id)
        assertEquals(65.0, candidate.amount, 0.001)
        assertEquals("9REAL0650AA", candidate.transactionId)
        assertEquals("01712345678", candidate.senderAccount)
        // Absent, not invented: the body names the payer, and the payee is resolved
        // on the JavaScript side from the seller's own connected account.
        assertNull(
            "a receipt that names no payee must not invent one",
            candidate.receiverAccount,
        )
        assertEquals(
            "parserVersion must be bumped when detection rules change",
            2,
            candidate.parserVersion,
        )
    }

    @Test
    fun `a recognised sender is not on its own enough to become a payment`() {
        // The other half of the fix, and the half that must not be traded away.
        //
        // bKash sends OTPs, promotions and campaign blasts from the same address, so
        // a recognised sender may claim a message but must never accept one. Each of
        // these is the same sender with the same transfer wording removed or turned
        // into money leaving.
        val refused = listOf(
            // Money leaving, not arriving. The payer sends this to their own handset.
            "You have sent Tk65.00 to 01712345678. TrxID: 9REAL0650AB" to
                "a sent message must never count as a receipt",
            // A promotion from the same address.
            "Enjoy 10% cashback on every payment this weekend. Tap to claim." to
                "marketing from a recognised sender must not be claimed",
            // Receipt wording, but no amount and no reference.
            "You have received money. Thank you for using bKash." to
                "a receipt with no amount or reference must be refused, not guessed",
        )

        for ((body, why) in refused) {
            val outcome = ProviderRegistry.parse(SmsMessage("bKash", body, 0L, "x"))
            assertTrue("$why (body: $body) got $outcome", outcome is ParseOutcome.Rejected)
        }
    }

    @Test
    fun `an unbranded receipt from an unrecognised sender is still refused`() {
        // Guards the fix against being undone by a contains-bKash rule.
        //
        // The unbranded real-world body is only acceptable because the address is one
        // bKash is known to use. From an address it does not use, the identical text
        // must be refused: recognition is what makes it readable, so without it there
        // is nothing but an unbranded message claiming money arrived.
        val outcome = ProviderRegistry.parse(
            SmsMessage(
                "01799000111",
                "You have received Tk65.00 from 01712345678. TrxID: 9REAL0650AC",
                0L,
                "x",
            ),
        )
        assertTrue(
            "an unbranded message from an unknown sender must not be attributed, got $outcome",
            outcome is ParseOutcome.Rejected,
        )
        assertEquals(
            "unsupported_provider",
            (outcome as ParseOutcome.Rejected).reason.id,
        )
    }

    @Test
    fun `a branded message is still read from an address not in the sender list`() {
        // The sender list is a second signal, not a gate. These addresses are not
        // publicly documented and a new one may appear without notice, so a body that
        // names its provider must keep working when the address is unrecognised --
        // otherwise adding a shortcode would silently become a prerequisite.
        val outcome = ProviderRegistry.parse(
            SmsMessage(
                "01600000000000",
                "bKash: You have received Tk 500 from 01712345678. TrxID: BRANDED0001",
                0L,
                "x",
            ),
        )
        assertTrue("a branded body must parse regardless of sender, got $outcome", outcome is ParseOutcome.Parsed)
    }

    @Test
    fun `sender matching is normalised and never a substring search`() {
        // `contains("bKash")` would accept any address with those letters inside it,
        // and deciding whose money a payment is requires an exact answer. So the
        // matching rule is checked directly, including the near misses.
        val bkash = ProviderRegistry.adapterFor(Provider.BKASH)!!
        val identities = bkash.senderIdentities

        assertTrue("exact match", SenderIdentity.matches("bKash", identities))
        assertTrue("lower case", SenderIdentity.matches("bkash", identities))
        assertTrue("spaced", SenderIdentity.matches("B KASH", identities))
        assertTrue("shortcode", SenderIdentity.matches("16247", identities))

        assertFalse("a longer address is not a match", SenderIdentity.matches("bKashBD", identities))
        assertFalse("a prefix is not a match", SenderIdentity.matches("bkas", identities))
        assertFalse("a phone number is not a match", SenderIdentity.matches("01712345678", identities))
        assertFalse("a neighbouring provider is not a match", SenderIdentity.matches("Nagad", identities))
        assertFalse("punctuation only matches nothing", SenderIdentity.matches("---", identities))
        assertFalse("empty matches nothing", SenderIdentity.matches("", identities))
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
            (outcome as ParseOutcome.Rejected).reason,
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
        //
        // Detection does not depend on the brand being in the body -- that was the
        // defect, since a real bKash receipt names only the payer -- so this case
        // deliberately carries the brand to prove the OTHER half still holds: a
        // message that names no payee never has one invented for it, whether it was
        // recognised by its body or by its sender.
        val withoutReceiver = ProviderRegistry.parse(
            SmsMessage(
                "bKash",
                "bKash: You have received Tk 500 from 01712345678. TrxID: NORECV001",
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
        //
        // A time is required as well as a date. "25/12/2024" with no clock is not
        // an instant, and defaulting it to midnight would place the payment at the
        // wrong end of an intent window.
        assertNull(MessageText.transactionTimestampMillis("received on 03/04/2024 at 10:32 am"))
        assertNotNull(MessageText.transactionTimestampMillis("received on 25/12/2024 at 10:32 am"))
        assertNotNull(MessageText.transactionTimestampMillis("received on 25 Dec 2024 at 10:32 am"))

        // And with no clock at all, nothing is invented.
        assertNull(MessageText.transactionTimestampMillis("received on 25/12/2024"))
        assertNull(MessageText.transactionTimestampMillis("received at 10:32 am"))
    }

    @Test
    fun `an unambiguous timestamp resolves to Asia Dhaka`() {
        // 25 Dec 2024 22:15 in Dhaka is 16:15 UTC. Getting this wrong would place
        // a payment at the wrong end of an intent window, so it is pinned.
        val millis = MessageText.transactionTimestampMillis("Cash In Tk 300 on 25 Dec 2024 10:15 pm")
        assertNotNull("a full date and clock must resolve", millis)
        assertEquals("2024-12-25T16:15:00.000Z", MessageText.iso8601(millis!!))
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