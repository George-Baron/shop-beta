# Support assistant

A chat button ("Ask us") on the store. It answers customers in plain English from your own facts and guides, checks an order's status, searches products and passes questions to your team.

## Switch it on
1. Create an API key in the Anthropic Console (console.anthropic.com) and add credit. Set a monthly spending limit there.
2. On Render add the variable `ANTHROPIC_API_KEY` and redeploy. Without it, customers see no chat button.
3. Optional: `ASSISTANT_MODEL` (default `claude-haiku-5-5`, small and cheap).
4. Admin > Settings > Support assistant: switch it on or off, set the daily cap, and add extra facts it may use (opening hours, special rules).

## What it does
- Answers from: your store facts (name, contact, returns window, free-delivery threshold, delivery fees by state, payment methods), the built-in guides (ordering, paying, tracking, delivery code, returns, partner stores, wholesale) and your extra facts.
- **Order status:** needs the order number AND the email used. It tells the status, payment status, items and the latest updates. It never shows phone, address, delivery code or payment details. A wrong email and an unknown order give the same answer.
- **Products:** searches visible products only (name, price, in stock, link).
- **Hand-off:** with the customer's name and email it puts the message in Admin > Messages and emails your contact address. One per chat.
- It cannot cancel, refund, approve or change anything, and it is told not to promise outcomes.

## Cost control and privacy
- Daily cap (default 500 messages a day, changeable). When reached, it stops calling Claude and points customers to Contact or WhatsApp.
- Per-visitor limit: 20 messages per 10 minutes.
- Conversations are not stored. Only a daily counter is kept. The text of a chat is sent to Anthropic to produce the answer, so mention this in your privacy page.
- The key stays on the server. The customer's browser never sees it.

## Limits
- It can be wrong. The chat says so, and the rules tell it to hand over when unsure. Read the hand-off messages for questions it could not answer, then add the answers to "Extra facts".
- Not tested against the real Anthropic service in this build: tests use a stand-in. Try it once with your key and a few real questions before announcing it.

Tests: `npm run test:assistant`.
