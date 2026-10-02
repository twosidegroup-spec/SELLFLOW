/**
 * Onboarding: create the business.
 *
 * The only step between signing up and using the app. It calls
 * `bootstrap_business`, which creates the organization, the owner membership
 * and the first store in a single transaction -- so a user can never end up
 * with a business they have no permission to write to.
 *
 * Deliberately asks for almost nothing (requirement 42). Store name and code
 * are optional and default sensibly; the user is not interrogated before they
 * can see the product.
 */

import { useState } from 'react';
import { ActivityIndicator, Image, Keyboard, View } from 'react-native';
import { router } from 'expo-router';
import { ArrowRight, Building2, LogOut, Store } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { Button, Input, Screen, Text } from '@/components/ui';
import { AppError } from '@/lib/errors';
import { getSupabase } from '@/lib/supabase';
import { useSession } from '@/store/session';
import { useTheme } from '@/theme/ThemeProvider';

interface BootstrapResult {
  org_id: string;
  store_id: string;
  created: boolean;
}

/**
 * Long enough that the transition reads as deliberate rather than as lag.
 */
const PREPARING_MINIMUM_MS = 900;

export default function OnboardingScreen() {
  const { spacing, colors, radius } = useTheme();
  const user = useSession((state) => state.user);
  const refreshWorkspace = useSession((state) => state.refreshWorkspace);
  const signOut = useSession((state) => state.signOut);

  const [businessName, setBusinessName] = useState('');
  const [storeName, setStoreName] = useState('');
  const [storeCode, setStoreCode] = useState('');
  const [errors, setErrors] = useState<{ businessName?: string; storeCode?: string }>({});
  const [formError, setFormError] = useState<AppError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [preparing, setPreparing] = useState(false);

  function validate(): boolean {
    const next: typeof errors = {};

    if (!businessName.trim()) next.businessName = 'Enter your business name.';
    else if (businessName.trim().length > 120) next.businessName = 'That name is too long.';

    // The code becomes the order-number prefix, so it must be short and
    // URL-safe. This mirrors the check constraint on stores.code.
    if (storeCode.trim() && !/^[A-Za-z0-9_-]{1,16}$/.test(storeCode.trim())) {
      next.storeCode = 'Use up to 16 letters, numbers, dashes or underscores.';
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit() {
    Keyboard.dismiss();
    setFormError(null);

    if (!validate()) return;

    setSubmitting(true);

    try {
      const { data, error } = await getSupabase().rpc('bootstrap_business', {
        p_business_name: businessName.trim(),
        p_store_name: storeName.trim() || null,
        p_store_code: storeCode.trim() || null,
      });

      if (error) throw AppError.from(error);

      const result = data as unknown as BootstrapResult;
      // `created: false` means this device already had a business (a retry after
      // a dropped connection); either way the workspace is now real.
      void result;

      // Re-read the workspace so the store and role come from the database
      // rather than being guessed here.
      await refreshWorkspace();

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      // Hold on a visible preparing state instead of navigating straight into
      // the app. Without it the button simply stops responding for as long as
      // the dashboard takes to fetch, which reads as a dead tap; and if the
      // dashboard resolves quickly the screen would flash past. A short,
      // guaranteed minimum keeps the transition deliberate either way.
      setPreparing(true);
      const startedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, PREPARING_MINIMUM_MS));
      await Promise.all([
        new Promise((resolve) => setTimeout(resolve, Math.max(0, PREPARING_MINIMUM_MS - (Date.now() - startedAt)))),
        router.replace('/(app)'),
      ]);
    } catch (error) {
      setFormError(AppError.from(error));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setPreparing(false);
    } finally {
      setSubmitting(false);
    }
  }

  /*
   * The moment the seller has finished registering and the app takes over.
   *
   * This deliberately holds a full-screen branded state rather than cutting
   * straight to the dashboard. Three reasons: the button must never look dead
   * while the dashboard fetches; a fast dashboard would otherwise flash past
   * with no acknowledgement at all; and the seller is seeing their business come
   * into existence, which deserves a moment rather than a jump cut.
   */
  if (preparing) {
    return (
      <Screen grow>
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            gap: spacing.lg,
            padding: spacing.lg,
          }}
        >
          <Image
            source={require('@/../assets/icon.png')}
            // radius.sheet, not a literal: an 88pt tile at the icon's own ~22%
            // corner proportion. The design audit rejects any radius that is not
            // a declared token.
            style={{ width: 88, height: 88, borderRadius: radius.sheet }}
            resizeMode="contain"
            accessibilityLabel="SellFlow"
          />
          <ActivityIndicator size="large" color={colors.primary} />
          <View style={{ alignItems: 'center', gap: spacing.xs }}>
            <Text variant="heading">Setting up your business</Text>
            <Text variant="caption" tone="muted" style={{ textAlign: 'center' }}>
              Getting your store ready
            </Text>
          </View>
        </View>
      </Screen>
    );
  }

  return (
    <Screen grow>
      <View style={{ flex: 1, justifyContent: 'center', maxWidth: 440, width: '100%', alignSelf: 'center' }}>
        <Text variant="micro" tone="muted">
          Step 1 of 1
        </Text>

        <Text variant="display" style={{ marginTop: spacing.xxs }}>
          Set up your business
        </Text>
        <Text variant="body" tone="muted" style={{ marginTop: spacing.xs, marginBottom: spacing.xl }}>
          {user?.email
            ? `Signed in as ${user.email}. Give your business a name to get started.`
            : 'Give your business a name to get started.'}
        </Text>

        {formError ? (
          <View style={{ marginBottom: spacing.md }}>
            <Text variant="caption" tone="danger">{formError.title}</Text>
            <Text variant="micro" tone="secondary" style={{ marginTop: 2 }}>{formError.action}</Text>
          </View>
        ) : null}

        <View style={{ gap: spacing.md }}>
          <Input
            label="Business name"
            required
            value={businessName}
            onChangeText={(text) => {
              setBusinessName(text);
              if (errors.businessName) setErrors((prev) => ({ ...prev, businessName: undefined }));
            }}
            placeholder="Apex Traders"
            icon={Building2}
            autoCapitalize="words"
            error={errors.businessName}
            showError
            editable={!submitting}
            returnKeyType="next"
          />

          <Input
            label="First store"
            value={storeName}
            onChangeText={setStoreName}
            placeholder="Main store"
            icon={Store}
            hint="Optional. You can add more stores later in Settings."
            editable={!submitting}
            returnKeyType="next"
          />

          <Input
            label="Store code"
            value={storeCode}
            onChangeText={(text) => {
              setStoreCode(text.toUpperCase());
              if (errors.storeCode) setErrors((prev) => ({ ...prev, storeCode: undefined }));
            }}
            placeholder="DHK"
            autoCapitalize="characters"
            maxLength={16}
            hint="Optional. Used as the prefix on order numbers, for example DHK-000001."
            error={errors.storeCode}
            showError
            editable={!submitting}
            returnKeyType="go"
            onSubmitEditing={() => void handleSubmit()}
          />

          <Button
            label="Start selling"
            icon={ArrowRight}
            iconPosition="trailing"
            onPress={() => void handleSubmit()}
            loading={submitting}
            block
            size="lg"
            style={{ marginTop: spacing.xs }}
          />

          <Button
            label="Sign out"
            variant="ghost"
            icon={LogOut}
            onPress={() => void signOut()}
            disabled={submitting}
            block
          />
        </View>
      </View>
    </Screen>
  );
}
