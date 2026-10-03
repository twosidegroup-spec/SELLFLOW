/**
 * Adds the entire native SMS surface to the Android manifest.
 *
 * Why a plugin rather than a field in app.json: docs/google-play-sms-policy.md
 * requires that the manifest diff for a restricted permission be explicit and
 * reviewable, and a library manifest arriving silently through autolinking is
 * the opposite of that. Here, both lines that grant SMS access live in one file
 * with a comment explaining each, and a test asserts this file still contains
 * them and still contains nothing else.
 *
 * Why not `android.permissions` in app.json: that would put the permission in
 * place without saying which receiver it is for, and the receiver is the part
 * that actually needs reviewing.
 *
 * The plugin is idempotent. Running prebuild twice, or running it over a
 * manifest that already has the entries, leaves exactly one permission and one
 * receiver.
 *
 * Deliberately absent: READ_SMS, SEND_SMS, WRITE_SMS, RECEIVE_MMS,
 * RECEIVE_WAP_PUSH, BROADCAST_SMS, BROADCAST_WAP_PUSH, contacts, and everything
 * in Call Log.
 *
 *   - READ_SMS would grant access to the user's entire inbox. Reading the inbox
 *     is a far broader permission than reading one notification, and this app has
 *     no feature that needs it.
 *   - SEND_SMS and WRITE_SMS are not used at all.
 *   - RECEIVE_MMS and RECEIVE_WAP_PUSH are not used at all.
 *   - BROADCAST_SMS is what gates `SMS_DELIVER`, which only the default SMS app
 *     may receive. SellFlow is not and will not become a default SMS handler, so
 *     asking for it would request a permission this feature cannot use.
 *
 * The plugin also strips any of the above if it finds one, so an unrelated edit
 * to app.json cannot quietly widen what this app asks a seller for.
 */

const { withAndroidManifest, WarningAggregator } = require('@expo/config-plugins');

/** The one permission this feature needs: receive an inbound SMS. */
const RECEIVE_SMS = 'android.permission.RECEIVE_SMS';

/** The class the platform broadcasts to. Defined in modules/sellflow-sms. */
const RECEIVER_CLASS = 'com.sellflow.sms.SellflowSmsReceiver';

const SMS_RECEIVED_ACTION = 'android.provider.Telephony.SMS_RECEIVED';

/**
 * Permissions that must never appear in this manifest.
 *
 * Declared here as well as in the boundary test on purpose. The test proves the
 * repository is clean; this list makes the plugin actively remove a violation
 * rather than merely refuse to add one.
 */
const FORBIDDEN_PERMISSIONS = [
  'android.permission.READ_SMS',
  'android.permission.SEND_SMS',
  'android.permission.WRITE_SMS',
  'android.permission.RECEIVE_MMS',
  'android.permission.RECEIVE_WAP_PUSH',
  'android.permission.BROADCAST_SMS',
  'android.permission.BROADCAST_WAP_PUSH',
  'android.permission.READ_CONTACTS',
  'android.permission.WRITE_CONTACTS',
  'android.permission.GET_ACCOUNTS',
  'android.permission.READ_CALL_LOG',
  'android.permission.WRITE_CALL_LOG',
  'android.permission.PROCESS_OUTGOING_CALLS',
  // A default-SMS-app permission. Holding it without the role promises something
  // this app does not do.
  'android.permission.READ_CELLPHONE_ARCHIVE',
];

const isForbidden = (name) =>
  typeof name === 'string' && FORBIDDEN_PERMISSIONS.includes(name.trim());

function nameOf(node) {
  return node && node.$ ? node.$['android:name'] : undefined;
}

/**
 * The manifest parser returns a bare object for an element that appears once and
 * an array for one that appears more than once.
 *
 * Both shapes have to be handled, and `<application>` must always be written back
 * as an ARRAY. Two reasons, both learned the hard way here:
 *
 *  - Assuming it was an array produced a *second* `<application>` element. Android
 *    ignores a manifest with two, so the receiver was dropped with no error
 *    anywhere in the build.
 *  - Writing it back as an object crashed every later config plugin, because
 *    `@expo/config-plugins`' own `getMainApplication` calls `.filter` on it.
 *
 * So: normalise to a list on the way in, always write a list on the way out.
 */
function asList(value) {
  if (Array.isArray(value)) return [...value];
  return value ? [value] : [];
}

function buildPermission() {
  return { $: { 'android:name': RECEIVE_SMS } };
}

function buildReceiver() {
  return {
    $: {
      'android:name': RECEIVER_CLASS,
      // Required from Android 12 for any component with an intent filter, and
      // true is correct here: the system invokes this receiver, not another app.
      'android:exported': 'true',
    },
    'intent-filter': [
      {
        $: {},
        action: [{ $: { 'android:name': SMS_RECEIVED_ACTION } }],
      },
    ],
  };
}

module.exports = function withSellflowSms(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults && cfg.modResults.manifest;
    if (!manifest) return cfg;

    // --- 1. Strip anything that must not be there ------------------------------
    const requested = asList(manifest['uses-permission']);
    const kept = requested.filter(
      (node) => nameOf(node) !== RECEIVE_SMS && !isForbidden(nameOf(node)),
    );

    if (kept.length !== requested.length) {
      WarningAggregator.addWarningAndroid(
        'sellflow-sms',
        'Removed a duplicate or forbidden uses-permission entry while adding the SMS listener.',
      );
    }

    // RECEIVE_SMS and nothing else. See the header for why each omission is a
    // decision rather than an oversight.
    manifest['uses-permission'] = [...kept, buildPermission()];

    // --- 2. Register the receiver inside the existing <application> ------------
    const applications = asList(manifest.application);
    if (applications.length === 0) applications.push({ $: {} });

    const withoutOurs = applications.map((application) => ({
      ...application,
      receiver: asList(application.receiver).filter(
        (node) => nameOf(node) !== RECEIVER_CLASS,
      ),
    }));

    withoutOurs[0].receiver.push(buildReceiver());
    manifest.application = withoutOurs;

    return cfg;
  });
};

/**
 * Exported for the boundary test.
 *
 * The test asserts against these lists rather than against the generated
 * manifest, because `app.json` is the wrong place to look for a permission this
 * feature never puts there, and `android/` is generated, git-ignored and absent
 * in a fresh clone.
 */
module.exports.RECEIVE_SMS = RECEIVE_SMS;
module.exports.RECEIVER_CLASS = RECEIVER_CLASS;
module.exports.SMS_RECEIVED_ACTION = SMS_RECEIVED_ACTION;
module.exports.FORBIDDEN_PERMISSIONS = FORBIDDEN_PERMISSIONS;