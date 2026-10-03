package com.sellflow.sms

import java.security.MessageDigest

/**
 * SHA-256 of the raw message.
 *
 * The only thing derived from the message body that is allowed to outlive it.
 * A hash lets a re-delivered identical message be recognised as the same message
 * -- the platform delivers broadcasts more than once in several situations, and
 * the engine needs to be able to tell that apart from a genuinely new payment --
 * without the text ever being kept.
 *
 * A hash cannot be read back into text, which is what makes it safe to keep and
 * safe to send.
 */
object Fingerprint {

    private const val ALGORITHM = "SHA-256"

    fun sha256(value: String): String {
        val digest = MessageDigest.getInstance(ALGORITHM)
        return digest.digest(value.toByteArray(Charsets.UTF_8))
            .joinToString(separator = "") { byte -> "%02x".format(byte) }
    }
}