# AI extraction test fixture

This folder holds one **fictional** land record, used to walk the end-to-end
"read a document with AI" flow by hand. It is a made-up page produced for this
repository: it is not an official record, it is not valid for any legal use, and
every name, number and place in it was invented for testing. Nothing here is a
credential or a real person's information.

| File | What it is |
| --- | --- |
| `BhoomiTrace_Fictional_Land_Record_AI_Test.pdf` | One-page PDF 1.7, 105 KiB, marked `SYNTHETIC TEST DATA — NOT AN OFFICIAL DOCUMENT — NOT VALID FOR LEGAL USE` with reference `BT-AI-TEST-001`. |

The upload cap is 5 MiB, so this 105 KiB file is comfortably inside it.

What a correct reading of this page should return:

| Field | Value printed on the page |
| --- | --- |
| খতিয়ান নম্বর (`khatian`) | `AI-TEST-001` |
| মৌজা (`mouza`) | `AI Test Mouza` |
| দাগ নম্বর (`dag`) | `AI-TEST-001` |
| জমির পরিমাণ (`area`) | `12.5000 decimal` |
| অংশ (`share`) | `1/1` |
| মালিকের নাম (`owner`) | `Md. Demo Rahman` |

Those values come from the PDF itself, so a judge can check the result against
the page that produced it.

## Run the demo in a browser

1. **Download the file.** Either clone the repository, or open
   [`BhoomiTrace_Fictional_Land_Record_AI_Test.pdf`](./BhoomiTrace_Fictional_Land_Record_AI_Test.pdf)
   on GitHub and use **Download raw file**.
2. **Sign in.** Open the demo (see the root `README.md` for the current URL) at
   `#/login`, or create an account at `#/register`. Use a real account, not
   `ডেমো` (demo) mode: demo mode never calls the API, so it cannot show a stored
   reading.
3. **Upload the PDF.** Go to `#/documents` → **নথি আপলোড**. Choose the PDF, give
   it a title (for example `AI test fixture`), and press **ফাইল আপলোড করুন**.
   Uploading stores the file only; it does **not** start extraction.
4. **Open the document.** Click the uploaded document in the **নথিপত্র** list to
   reach its detail page.
5. **Start the reading.** In the **AI থেকে পড়া তথ্য** section press
   **AI দিয়ে তথ্য পড়ুন**, choose which of your land records to attach the
   reading to, then press **পাঠ শুরু করুন**. The page states, before you confirm,
   that the stored PDF will be sent to the provider the deployment configured.
6. **Wait.** The section shows that the job is running and follows it to the end
   (a one-page read usually takes well under a minute). Nothing is reported as a
   result until the job has actually finished.
7. **Review the fields.** The six rows above appear with what the model read, and
   a **পাঠ দিয়েছে** line naming the provider and model that answered (a recorded
   real run used `gemini` / `gemini-2.5-flash`). An unclear reading is flagged
   `অস্পষ্ট` and asks for a person; a correction made by a person is shown
   separately as the reviewed value. A failed job is reported as a failure with
   its reason, never as a reading.
8. **Check it against the PDF.** Press **মূল ফাইল ডাউনলোড করুন** and compare every
   value. An AI reading is a proposal, not official or legal verification.

## If the picker has no records

A reading is stored against a land record, and an account only sees its own
records, so a brand-new account has nothing to choose. The application
deliberately has no page that creates a record — it must not invent land data —
so create one through the documented API while signed in:

```bash
# Copy the values of the bt_session and bt_csrf cookies from your browser's
# devtools (Application/Storage → Cookies) after signing in.
curl -X POST 'https://<your-demo-host>/api/v1/parcels' \
  -H 'content-type: application/json' \
  -H 'x-csrf-token: <bt_csrf cookie value>' \
  -b 'bt_session=<bt_session cookie value>; bt_csrf=<bt_csrf cookie value>' \
  -d '{
    "survey": "BS",
    "khatianNumber": "AI-TEST-001",
    "mouza": "AI Test Mouza",
    "jlNumber": "999",
    "upazila": "Mirzapur",
    "district": "Tangail",
    "areaDecimal": "12.5000",
    "shareNumerator": 1,
    "shareDenominator": 1,
    "dagNumbers": ["AI-TEST-001"]
  }'
```

`survey` is one of `CS`, `SA`, `RS`, `BS`. The record is created as your own
(`origin: "user_created"`) and appears in the picker after you reload the page.
The in-app picker shows the same instruction, so nobody has to guess.

## Running this without a live provider

The frontend test suite exercises the display, the queue-and-poll flow, the
failure states and the demo behaviour with mocked HTTP responses:

```bash
cd frontend
pnpm test          # node:test, no network
pnpm exec tsc --noEmit
pnpm run build
```

No paid provider call is made by any of these.
