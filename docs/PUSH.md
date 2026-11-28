# Phone and browser alerts (Web Push)

Every in-app notification (money added, refund, points earned or expiring, order status, card news, staff alerts) is also pushed to the devices a person has switched alerts on for. Off until the shop has keys.

## Turn it on (once)
1. Make keys: `node -e "console.log(require('web-push').generateVAPIDKeys())"`
2. On Render set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (for example `mailto:support@yourshop.com`). Keep the private key secret; never change it later or everyone has to re-subscribe.
3. Customers then see **Alerts on this device** in Account > Wallet. They tap Turn on alerts and allow notifications.

## How it works
- `/sw.js` (service worker) shows the alert and opens the right page when tapped. It caches nothing.
- `notify()` saves the in-app notification as before, then queues a `push.send` job per person. A failing push never affects the action that caused it.
- A device the browser reports as gone (404/410) is removed; one that fails 5 times in a row is dropped. Limit: 10 devices per person.
- Promotional notifications (`type: promo`) are never pushed.

## Limits
- This is browser/PWA push. iPhone needs the site added to the Home Screen first (Safari rule). A native phone app needs its own Firebase/APNs setup and is not part of this.
- Tested against a stand-in push service (`npm run test:push`): the real browser services (Google, Mozilla, Apple) were not reachable here. After enabling, switch alerts on in your own phone and send yourself a test (Admin > Notifications > announcement to employees).
