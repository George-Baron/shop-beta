import * as WebBrowser from 'expo-web-browser';
import React from 'react';
import { Body, Button, Card, H2, Screen } from '@/components/ui';
import { APP_VERSION, PRIVACY_URL, TERMS_URL } from '@/lib/config';

export default function About() {
  return (
    <Screen>
      <Card>
        <H2>VELTO-MART</H2>
        <Body muted>Version {APP_VERSION}</Body>
      </Card>
      <Button title="Privacy policy" kind="secondary" onPress={() => WebBrowser.openBrowserAsync(PRIVACY_URL)} style={{ marginBottom: 12 }} />
      <Button title="Terms of service" kind="secondary" onPress={() => WebBrowser.openBrowserAsync(TERMS_URL)} />
    </Screen>
  );
}
