import { Image } from 'expo-image';
import React from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Controller, type Control, type FieldValues, type Path } from 'react-hook-form';
import { imageUrl } from '@/lib/config';
import { ApiError } from '@/lib/api';
import { colors, font, radius, space } from '@/theme';

export function Screen({ children, scroll = true, onRefresh, refreshing, edges = ['bottom'] as ('top' | 'bottom')[], style }: { children: React.ReactNode; scroll?: boolean; onRefresh?: () => void; refreshing?: boolean; edges?: ('top' | 'bottom')[]; style?: ViewStyle }) {
  return (
    <SafeAreaView style={[s.screen, style]} edges={edges}>
      {scroll ? (
        <ScrollView contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled" refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.gold} /> : undefined}>{children}</ScrollView>
      ) : children}
    </SafeAreaView>
  );
}

export function Button({ title, onPress, kind = 'primary', loading, disabled, style, testID }: { title: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger' | 'link'; loading?: boolean; disabled?: boolean; style?: ViewStyle; testID?: string }) {
  const off = disabled || loading;
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ disabled: !!off, busy: !!loading }} onPress={off ? undefined : onPress}
      style={({ pressed }) => [s.btn, kind === 'primary' && s.btnPrimary, kind === 'secondary' && s.btnSecondary, kind === 'danger' && s.btnDanger, kind === 'link' && s.btnLink, off && { opacity: 0.55 }, pressed && { opacity: 0.8 }, style]}>
      {loading ? <ActivityIndicator color={kind === 'primary' ? colors.navy : colors.ink} /> : <Text style={[s.btnText, kind === 'secondary' && { color: colors.navy }, kind === 'danger' && { color: colors.white }, kind === 'link' && { color: colors.navy, textDecorationLine: 'underline' }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field<T extends FieldValues>({ control, name, label, error, ...rest }: { control: Control<T>; name: Path<T>; label: string; error?: string } & TextInputProps) {
  return (
    <View style={{ marginBottom: space.md }}>
      <Text style={s.label}>{label}</Text>
      <Controller control={control} name={name} render={({ field }) => (
        <TextInput {...rest} value={String(field.value ?? '')} onChangeText={field.onChange} onBlur={field.onBlur} accessibilityLabel={label} placeholderTextColor={colors.muted}
          style={[s.input, !!error && { borderColor: colors.danger }, rest.multiline && { minHeight: 90, textAlignVertical: 'top' }]} />
      )} />
      {error ? <Text style={s.err} accessibilityRole="alert">{error}</Text> : null}
    </View>
  );
}

export const H1 = ({ children }: { children: React.ReactNode }) => <Text accessibilityRole="header" style={s.h1}>{children}</Text>;
export const H2 = ({ children }: { children: React.ReactNode }) => <Text accessibilityRole="header" style={s.h2}>{children}</Text>;
export const Body = ({ children, muted, style, onPress }: { children: React.ReactNode; muted?: boolean; style?: object; onPress?: () => void }) => <Text accessibilityRole={onPress ? 'link' : undefined} onPress={onPress} style={[s.body, muted && { color: colors.muted }, style]}>{children}</Text>;
export const Card = ({ children, style }: { children: React.ReactNode; style?: ViewStyle }) => <View style={[s.card, style]}>{children}</View>;
export const Row = ({ children, style }: { children: React.ReactNode; style?: ViewStyle }) => <View style={[{ flexDirection: 'row', alignItems: 'center' }, style]}>{children}</View>;

export const Banner = ({ kind = 'info', children }: { kind?: 'info' | 'error' | 'ok'; children: React.ReactNode }) => (
  <View accessibilityRole={kind === 'error' ? 'alert' : undefined} style={[s.banner, kind === 'error' && { backgroundColor: colors.dangerSoft }, kind === 'ok' && { backgroundColor: colors.okSoft }]}>
    <Text style={{ color: kind === 'error' ? colors.danger : colors.ink, fontSize: font.body }}>{children}</Text>
  </View>
);

export const Loading = () => <View style={s.center}><ActivityIndicator size="large" color={colors.gold} /></View>;
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
  return (
    <View style={s.center}>
      <Text style={[s.body, { textAlign: 'center', marginBottom: space.md }]}>{msg}</Text>
      {onRetry ? <Button title="Try again" kind="secondary" onPress={onRetry} /> : null}
    </View>
  );
}
export const Empty = ({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) => (
  <View style={s.center}><Text style={s.h2}>{title}</Text>{hint ? <Text style={[s.body, { color: colors.muted, textAlign: 'center', marginTop: space.sm }]}>{hint}</Text> : null}{action ? <View style={{ marginTop: space.lg }}>{action}</View> : null}</View>
);

export function Pic({ uri, emoji, size = 72, radiusPx = radius.md }: { uri?: string | null; emoji?: string; size?: number; radiusPx?: number }) {
  const src = imageUrl(uri);
  return src
    ? <Image source={{ uri: src }} style={{ width: size, height: size, borderRadius: radiusPx, backgroundColor: colors.line }} contentFit="cover" transition={150} accessibilityIgnoresInvertColors />
    : <View style={{ width: size, height: size, borderRadius: radiusPx, backgroundColor: colors.goldSoft, alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: size / 2 }}>{emoji || '🛒'}</Text></View>;
}

export const Chip = ({ label, active, onPress }: { label: string; active?: boolean; onPress: () => void }) => (
  <Pressable accessibilityRole="button" accessibilityState={{ selected: !!active }} onPress={onPress} style={[s.chip, active && { backgroundColor: colors.navy, borderColor: colors.navy }]}>
    <Text style={{ color: active ? colors.white : colors.ink, fontSize: font.small }}>{label}</Text>
  </Pressable>
);

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: space.lg, paddingBottom: space.xl * 2 },
  btn: { minHeight: 48, borderRadius: radius.md, paddingHorizontal: space.lg, alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { backgroundColor: colors.gold }, btnSecondary: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.navy }, btnDanger: { backgroundColor: colors.danger }, btnLink: { minHeight: 40 },
  btnText: { fontSize: font.h3, fontWeight: '700', color: colors.navy },
  label: { fontSize: font.small, fontWeight: '600', color: colors.ink, marginBottom: 6 },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, backgroundColor: colors.white, paddingHorizontal: space.md, fontSize: font.body, color: colors.ink },
  err: { color: colors.danger, fontSize: font.small, marginTop: 4 },
  h1: { fontSize: font.h1, fontWeight: '800', color: colors.navy, marginBottom: space.md },
  h2: { fontSize: font.h2, fontWeight: '700', color: colors.navy, marginBottom: space.sm },
  body: { fontSize: font.body, color: colors.ink, lineHeight: 21 },
  card: { backgroundColor: colors.white, borderRadius: radius.lg, padding: space.lg, marginBottom: space.md, borderWidth: 1, borderColor: colors.line },
  banner: { backgroundColor: colors.warnSoft, borderRadius: radius.md, padding: space.md, marginBottom: space.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, minHeight: 240 },
  chip: { borderWidth: 1, borderColor: colors.line, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 8, marginRight: space.sm, backgroundColor: colors.white },
});
