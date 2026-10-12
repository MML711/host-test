# host-test

A throwaway test for **AgriTrack's** choice of host and SMS provider (LT-1 / LT-5). It answers, by trying, what
the providers' websites don't say. Delete the repository when the tests are done.

- **`api/`** — a tiny server that behaves like AgriTrack's API where it matters: live connections (socket.io), a
  timer job inside the process, a PostgreSQL database. It sits in a subfolder on purpose, like AgriTrack's `API/`.
- **`sms-test/`** — a script that sends AgriTrack's real texts through SMSEthiopia or AfroMessage and follows each
  provider's own delivery status.

## 1. Host test (AletCloud, free tier)

**Deploy**
1. AletCloud → **App hosting → Create app** → connect GitHub → pick `MML711/host-test`, branch `main`.
2. If it asks for a root or source directory, enter **`api`**. If there's no such setting and the build fails,
   that is a finding — note it (a Dockerfile can fix it).
3. Plan: **Solo (free)**. No settings needed.
4. Optional, for the database checks: **Managed databases → create a Solo PostgreSQL database** and link it to the
   app (the app reads `DATABASE_URL`).
5. Open the app's address — the test page loads.

**What to check and note**

| # | Check | How |
|---|---|---|
| 1 | Live connections stay open | Leave the page open 10+ minutes. Both boxes A and B should stay **connected**, ticks counting up every 15 s. |
| 2 | Real WebSockets | Box **B** uses WebSocket only. If B can't connect while A works, the host doesn't pass WebSockets through. Box A's transport should end as `websocket`. |
| 3 | Exactly one copy | Press **How many copies?** — "ONE copy answered" is what AgriTrack needs. |
| 4 | Redeploy | Push any small change (or press redeploy). Watch the event log: when the old copy says "shutting down", how long until the new copy answers, and do A and B reconnect on their own? With a database linked, **Job runs per copy** shows whether two copies ran at the same time. |
| 5 | Outgoing calls | Press **Outgoing calls** — every service should show `reachable: true`. |
| 6 | Database | Press **Database**: version, `timezone` (we want UTC), whether our login is a superuser, available extensions. Then **try a limited login** — `allowed` means we can give the app its own limited login. |

The server also prints a log line for every connection, job run and shutdown — AletCloud's runtime log shows them.

## 2. SMS test (SMSEthiopia vs AfroMessage)

**Set up once**
1. Install Node.js 20 or newer (no packages needed for this script).
2. SMSEthiopia: **Phonebook → verify every test phone** (the free texts only reach verified numbers). Then
   **API KEY → create a key**.
3. AfroMessage: verify your phone number in the profile; find your API token.
4. In `sms-test/`, copy `.env.example` to `.env` and paste the keys. `.env` is never committed.
5. Write the Amharic code text on the first line of `sms-test/amharic.txt` (with `{code}` where the code goes,
   within 70 characters).

**Send** (from `sms-test/`)
```
node send.mjs --texts                                       # the four texts and their size
node send.mjs --provider smsethiopia --to ethio --text 1     # TEST_ETHIO_NUMBER from .env
node send.mjs --provider afromessage --to safaricom --text 1 # TEST_SAFARICOM_NUMBER from .env
```
Put your test numbers in `.env` as `TEST_ETHIO_NUMBER` / `TEST_SAFARICOM_NUMBER` (see `.env.example`) — then they
never appear in commands or logs. Both providers' free accounts only send to numbers verified in their dashboards.
Texts: **1** English code · **2** Amharic code · **3** alert with "•" (2 SMS parts) · **4** the same alert with
"*" (1 part).

For each send, note when the phone shows it, how the sender appears and whether it reads correctly; the script
adds the provider's own status and timing to `results.csv` (not committed — it holds phone numbers).

Rounds: daytime, ~10 PM and ~6 AM (the night rounds check whether codes are delivered outside 8 AM–9 PM), on
both an Ethio Telecom and a Safaricom number. Note: SMSEthiopia's documentation says its API only accepts numbers
starting with 2519 (Ethio Telecom) — a Safaricom number (2517…) should be refused with error 10000.
