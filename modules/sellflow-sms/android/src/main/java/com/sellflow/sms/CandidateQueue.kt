package com.sellflow.sms

import android.content.Context
import com.sellflow.sms.providers.PaymentCandidate
import com.sellflow.sms.providers.Provider
import org.json.JSONArray
import org.json.JSONObject

/**
 * The durable queue of normalised payment candidates.
 *
 * This is the component that makes the listener work when the app is closed. An
 * inbound SMS starts the app process, [SellflowSmsReceiver] parses the message
 * and hands the result here; the React Native runtime may not exist yet, or may
 * never be started again before the seller opens the app. Nothing is delivered
 * until JavaScript drains it.
 *
 * **Only normalised fields are ever written.** No raw message body, no sender
 * address, no free text of any kind. Every row here is already exactly the
 * argument list of `ingest_payment_event`, which means the queue cannot leak
 * anything the payment contract would not have sent anyway. See
 * docs/sms-adapter-contract.md, which forbids storing the body.
 *
 * Writes use `commit()` rather than `apply()`. A broadcast receiver can be torn
 * down the instant `onReceive` returns, so an asynchronous write would lose
 * exactly the payments the seller was not watching for.
 *
 * Ordering is oldest-first, so a reconnect storm replays in the order the money
 * arrived rather than in the order it happened to be drained.
 */
class CandidateQueue(context: Context) {

    private val prefs = context.applicationContext
        .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /**
     * Queues a candidate, or recognises it as already queued.
     *
     * Dedupe is on the provider reference, not the message fingerprint. A
     * broadcast redelivery has the same fingerprint; the same transfer reported
     * twice by an operator has the same TrxID. Either way it is one payment, and
     * the server refuses a second one regardless.
     */
    fun enqueue(candidate: PaymentCandidate) {
        val rows = readRows()
        if (rows.any { identityOf(it) == identityOf(candidate) }) return

        if (rows.size >= MAX_CANDIDATES) {
            // Never grow without bound. Dropping the newest is the honest choice:
            // the sender's own statement remains the record of a payment this
            // device could not queue, and dropping the oldest would silently lose
            // one that may already be matched.
            recordDrop()
            return
        }

        rows.add(toJson(candidate))
        writeRows(rows)
    }

    /**
     * Every queued candidate, oldest first, **leaving them queued**.
     *
     * Reading does not consume. JavaScript persists the batch into its own durable
     * queue and only then acknowledges, so a process death in between causes a
     * redelivery of the same candidates rather than a loss. Redelivery is safe:
     * the JS queue recognises them by fingerprint and the server refuses a second
     * payment regardless.
     */
    fun peek(): List<PaymentCandidate> = readRows().mapNotNull { fromJson(it) }

    /** Removes the named candidates, after JavaScript has persisted them. */
    fun acknowledge(fingerprints: Collection<String>): Int {
        if (fingerprints.isEmpty()) return 0
        val doomed = fingerprints.toSet()
        val rows = readRows()
        val kept = rows.filter { it.optString(KEY_FINGERPRINT) !in doomed }
        val removed = rows.size - kept.size
        if (removed > 0) writeRows(kept)
        return removed
    }

    /** Removes one candidate the server has definitively refused or aged out. */
    fun discard(fingerprint: String): Boolean {
        val rows = readRows()
        val kept = rows.filter { it.optString(KEY_FINGERPRINT) != fingerprint }
        if (kept.size == rows.size) return false
        writeRows(kept)
        return true
    }

    /** Removes one candidate the server has definitively refused or aged out. */
    fun discard(fingerprint: String): Boolean {
        val rows = readRows()
        val kept = rows.filter { it.optString(KEY_FINGERPRINT) != fingerprint }
        if (kept.size == rows.size) return false
        writeRows(kept)
        return true
    }

    fun count(): Int = readRows().size

    /** Age in milliseconds of the oldest queued candidate, or 0 when empty. */
    fun oldestDetectedAt(): Long {
        val rows = readRows()
        if (rows.isEmpty()) return 0L
        val oldest = rows.minOf { it.optLong(KEY_DETECTED_AT, 0L) }
        return if (oldest <= 0L) 0L else System.currentTimeMillis() - oldest
    }

    /** Counts a non-settling parse outcome. No message text is retained. */
    fun recordRejection(reason: String) {
        val counters = readCounters()
        counters.put(reason, counters.optInt(reason, 0) + 1)
        writeCounters(counters)
    }

    fun rejectionCounts(): Map<String, Int> {
        val counters = readCounters()
        return counters.keys().asSequence().associateWith { counters.optInt(it, 0) }
    }

    /** How many candidates were dropped because the queue was full. */
    fun droppedCount(): Int = prefs.getInt(KEY_DROPPED, 0)

    // ---------------------------------------------------------------- internals

    private fun readRows(): JSONArray =
        runCatching { JSONArray(prefs.getString(KEY_ROWS, "[]") ?: "[]") }
            .getOrDefault(JSONArray())

    private fun writeRows(rows: JSONArray) {
        // commit(), not apply(): see the class comment.
        prefs.edit().putString(KEY_ROWS, rows.toString()).commit()
    }

    private fun readCounters(): JSONObject =
        runCatching { JSONObject(prefs.getString(KEY_REJECTIONS, "{}") ?: "{}") }
            .getOrDefault(JSONObject())

    private fun writeCounters(counters: JSONObject) {
        prefs.edit().putString(KEY_REJECTIONS, counters.toString()).commit()
    }

    private fun recordDrop() {
        prefs.edit().putInt(KEY_DROPPED, droppedCount() + 1).commit()
    }

    /**
     * What makes two rows the same payment.
     *
     * Provider plus reference plus amount. The server's own constraint is
     * provider, account and transaction id, but the account is not known here --
     * it is resolved from the seller's connected accounts on the JS side -- so
     * the device dedupes as narrowly as it honestly can and the server does the
     * rest.
     */
    private fun identityOf(row: JSONObject): String {
        val candidate = fromJson(row) ?: return row.toString()
        return "${candidate.provider.id}|${candidate.transactionId}|${candidate.amount}"
    }

    private fun identityOf(candidate: PaymentCandidate): String =
        "${candidate.provider.id}|${candidate.transactionId}|${candidate.amount}"

    private fun toJson(candidate: PaymentCandidate): JSONObject = JSONObject().apply {
        put(KEY_PROVIDER, candidate.provider.id)
        put(KEY_TRANSACTION_ID, candidate.transactionId)
        put(KEY_AMOUNT, candidate.amount)
        // Absent stays absent. Inventing a receiver here would put a number in
        // the ledger that no message ever stated.
        if (candidate.receiverAccount != null) put(KEY_RECEIVER, candidate.receiverAccount)
        if (candidate.senderAccount != null) put(KEY_SENDER, candidate.senderAccount)
        candidate.transactionTimestamp?.let { put(KEY_TRANSACTION_AT, it) }
        put(KEY_FINGERPRINT, candidate.fingerprint)
        put(KEY_DETECTED_AT, candidate.detectedAt)
        put(KEY_PARSER_VERSION, candidate.parserVersion)
    }

    private fun fromJson(row: JSONObject): PaymentCandidate? = runCatching {
        val provider = Provider.fromId(row.optString(KEY_PROVIDER)) ?: return null
        val reference = row.optString(KEY_TRANSACTION_ID)
        if (reference.isBlank()) return null
        PaymentCandidate(
            provider = provider,
            transactionId = reference,
            amount = row.optDouble(KEY_AMOUNT, 0.0),
            receiverAccount = row.optStringOrNull(KEY_RECEIVER),
            senderAccount = row.optStringOrNull(KEY_SENDER),
            transactionTimestamp = row.optLongOrNull(KEY_TRANSACTION_AT),
            fingerprint = row.optString(KEY_FINGERPRINT),
            detectedAt = row.optLong(KEY_DETECTED_AT, System.currentTimeMillis()),
            parserVersion = row.optInt(KEY_PARSER_VERSION, 1),
        )
    }.getOrNull()

    private fun JSONObject.optStringOrNull(key: String): String? {
        if (!has(key) || isNull(key)) return null
        val value = optString(key)
        return value.takeIf { it.isNotBlank() }
    }

    private fun JSONObject.optLongOrNull(key: String): Long? {
        if (!has(key) || isNull(key)) return null
        return optLong(key)
    }

    private companion object {
        const val PREFS_NAME = "sellflow_sms_queue"

        const val KEY_ROWS = "candidates"
        const val KEY_REJECTIONS = "rejections"
        const val KEY_DROPPED = "dropped"

        const val KEY_PROVIDER = "provider"
        const val KEY_TRANSACTION_ID = "transactionId"
        const val KEY_AMOUNT = "amount"
        const val KEY_RECEIVER = "receiverAccount"
        const val KEY_SENDER = "senderAccount"
        const val KEY_TRANSACTION_AT = "transactionTimestamp"
        const val KEY_FINGERPRINT = "fingerprint"
        const val KEY_DETECTED_AT = "detectedAt"
        const val KEY_PARSER_VERSION = "parserVersion"

        /**
         * Far more than a seller accumulates in a day. A queue this deep means the
         * device has been offline for weeks, and replaying hundreds of events at
         * once would stall the app on start for no benefit.
         */
        const val MAX_CANDIDATES = 500
    }
}