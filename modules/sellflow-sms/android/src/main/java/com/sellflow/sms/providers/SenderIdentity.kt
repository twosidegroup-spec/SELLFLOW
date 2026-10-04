package com.sellflow.sms.providers

import java.util.Locale

/**
 * Turning an SMS originating address into a provider identity.
 *
 * **Why this exists.** Provider detection originally read the provider's own name
 * out of the message *body*, because that was the only signal available. A real
 * bKash payment notification does not carry it: bKash's own security guidance
 * tells customers to look for the transaction SMS "from bKash", which is the
 * originating address, while the body is a bare receipt --
 * "You have received Tk 65.00 from 017...", naming the payer and never the
 * provider. A real 65 BDT payment was received by the app, refused by this
 * module, and counted as `unsupported_provider` with nothing on screen to say so.
 * The brand is in the sender, so the sender is what detection has to read.
 *
 * **Why this is a set lookup and not `contains("bKash")`.** A substring rule over
 * a sender field is unsafe in a specific way: sender addresses are short, so
 * `contains` on them collides with unrelated values, and a loose match here
 * decides whose money a payment is. This normalises and then requires *equality*
 * against a provider's own declared set. Nothing outside the set matches, so an
 * unrecognised operator is simply unrecognised -- it is never guessed at.
 *
 * Normalisation strips separators and folds case, because operators really do
 * send as `bKash`, `BKASH` and `bkash`, and because a declared shortcode must
 * still match when the network renders it as `+880...` is *not* attempted:
 * digits and letters are compared as given.
 *
 * **The body-brand path still exists and is still authoritative.** An address
 * that is absent from every set is not a dead end -- if the operator stamped its
 * name on the message, the adapters still claim it. This set is a second,
 * independent signal, not a replacement, precisely because the addresses below
 * are not publicly documented and a new one may appear without notice.
 */
object SenderIdentity {

    private val SEPARATORS = Regex("[^A-Za-z0-9]+")

    /**
     * The canonical form of an originating address: letters and digits only,
     * upper-cased.
     *
     * Empty for an address that is entirely punctuation, which must never match a
     * provider.
     */
    fun normalize(raw: String): String =
        raw.trim().replace(SEPARATORS, "").uppercase(Locale.ROOT)

    /**
     * Whether [raw] is one of [identities].
     *
     * [identities] holds already-normalised values, so this is a set membership
     * test against a closed list rather than a pattern search over user data.
     */
    fun matches(raw: String, identities: Set<String>): Boolean {
        val candidate = normalize(raw)
        if (candidate.isEmpty()) return false
        return identities.contains(candidate)
    }
}
