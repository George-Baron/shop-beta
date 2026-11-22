# VELTO-MART mobile: store listing and privacy answers (draft for your review)

These are drafts based on what the app and server actually do today. Check each answer again before submitting, and update it if the app changes. Nothing here has been submitted.

## Listing text
**App name:** VELTO-MART (30 characters max on both stores)
**Short description (Google, 80):** Shop online in Nigeria and follow your delivery. Wholesale for businesses.
**Subtitle (Apple, 30):** Shop. Pay. Track delivery.
**Full description:**
> VELTO-MART brings the store to your phone. Browse departments, search products, and check out in Naira with pay on delivery or a secure card and bank payment page. Follow every order from "placed" to "delivered", get a short alert when something changes, and message our team if you need help.
>
> Business owner? Apply for a wholesale account in the app. Once approved you see wholesale prices, request a quotation, accept it, pay, and follow your delivery.
>
> • Browse and search by department • Cart saved on your phone • Pay on delivery or by card/bank transfer through Paystack • Order tracking and delivery code • Order and delivery alerts you can switch off • Contact support from any order • Wholesale quotations for approved businesses • Delete your account any time from the app
**Category:** Shopping. **Content rating:** answer the questionnaires honestly (pharmacy items with prescriptions are sold; no user-generated content visible to other users except product reviews written by customers).
**Keywords (Apple, 100):** online shop,nigeria,lagos,groceries,delivery,wholesale,pharmacy,electronics,fashion,pay on delivery
**Support URL / marketing URL:** your website. **Privacy policy URL:** `<site>/page/privacy`. **Terms:** `<site>/page/terms`.
Do not mention Interswitch, Flutterwave or Monnify anywhere in the listing.

## Google Play: Data safety (answers match the current app)
| Data | Collected | Shared | Why | Optional | Notes |
| --- | --- | --- | --- | --- | --- |
| Name, email address, phone number | Yes | No (see below) | Account, orders, delivery | Phone optional at sign-up, needed to order | |
| Physical address | Yes | No | Delivery | Required to order | Rider sees it for the delivery |
| Purchase history | Yes | No | Orders and support | Required | |
| Device or other IDs (random install id, Expo push token) | Yes | Expo (push service) | Sign-in sessions, notifications | Push is optional | |
| App version, device model/name (device list) | Yes | No | Security (show signed-in devices) | | |
| Photos/files, location, contacts, microphone, camera | **No** | | | | The app does not use them (no image picker is installed). Add them to this table if you ever add photo upload |
| Payment info (card numbers) | **No** | | | | Cards are entered on the Paystack/Stripe page, never in the app or our server |
"Shared": payment processors (Paystack, Stripe), delivery riders and partner stores receive only what they need to complete an order, as service providers. Google's form treats service providers acting for you as not "shared"; confirm with the policy wording.
Security: data encrypted in transit (HTTPS); customers can request deletion (in app and on the web); no data sold.

## Apple: App Privacy ("nutrition labels")
Data linked to the user, used for App Functionality (and not for tracking): Contact Info (name, email, phone, physical address), Purchases, Identifiers (device id; push token), Usage/diagnostics only if you add analytics (none today). **No tracking, no advertising SDKs, no ATT prompt needed.** Declare the payment pages as web views in the review notes.
Export compliance: the app uses only standard HTTPS: `ITSAppUsesNonExemptEncryption` is set to `false`.
Apple 5.1.1(v): **in-app account deletion is built** (Account > Delete my account). Apple 3.1.1: physical goods use external payment, allowed.
Sign in with Apple is **not required**: the app offers only its own email account, no third-party social login.

## Account deletion (required by both stores)
- In the app: Account > Delete my account (needs the password; blocked while an order or wholesale quotation is open; account switched off at once; personal data erased after the waiting period; order and payment records kept without personal details).
- **Google Play also needs a public web page** that explains how to request deletion. The website does not have one yet: add a section to the privacy page or a `/page/delete-account` page that says to use the app, or email the store address, and give the retention rules. Put that URL in the Play Console.

## Privacy policy changes needed (the website's current page was written for the website)
Add: the mobile app and what it stores on the phone (a sign-in token in the secure storage; cart contents); device name/model and app version shown in "signed-in devices"; push notification tokens and Expo as the delivery service; support messages; the account-deletion waiting period and what is kept; wholesale business details (name, registration number, address) for approved buyers; that cards are handled by Paystack/Stripe; contact details for data requests; the Nigeria Data Protection Act basis and your registered controller details. Have the final text checked by someone qualified.

## Reviewer notes (paste into App Store Connect / Play Console, then add real credentials)
> VELTO-MART is a shopping app for a Nigerian online store. Browsing needs no account. Sign in with the demo account below to see orders. Checkout offers Pay on Delivery (use this for testing; no real charge). Online card payment opens the Paystack secure page and is live, so please do not complete it. Wholesale features require an approved business account; the demo account below is approved. Account deletion: Account > Delete my account.
> Demo customer: <email> / <password>   Demo wholesale buyer: <email> / <password>
(Create these accounts on the live site first; keep them out of real reporting.)

## Assets still to produce
- Icon 1024×1024 and adaptive icon: **drafted from the site logo** (`mobile/assets/images`), check them with a designer.
- Screenshots (6.7" and 6.1" iPhone, 5.5" optional; Android phone; 7"/10" tablet only if tablets are supported: they are not, `supportsTablet: false`). Take them from real builds.
- Feature graphic 1024×500 (Google).
