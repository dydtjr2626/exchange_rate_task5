# Real-time Exchange Rate & AI Chatbot Dashboard (Task 04)

## 1. Project Overview
Develop a real-time Exchange Rate Dashboard (USD, JPY) that satisfies all technical and resilience requirements specified in `과제 4.txt`. The application fetches live currency exchange rates, tracks daily history, handles failure states gracefully by preserving the last known good data, and provides an AI-assisted analysis chatbot.

---

## 2. Core Technical Architecture

### Tech Stack
- **Frontend:** Single-Page Application (HTML, CSS, Plain JavaScript or React)
- **State/Persistence:** Browser `localStorage` for offline history and last known valid values (`fresh` / `stale` flags).
- **Backend / API Proxy:** Vercel Serverless Functions (Node.js) for securing API keys.
- **External APIs:**
  - **Exchange Rate API:** Keyless free API (e.g., `Frankfurter API` or `ExchangeRate-API`) for live USD and JPY exchange rates.
  - **AI Chatbot API:** Google Gemini API (Free Tier) via Serverless Function.

### Security Mandate (`과제 4.txt` Compliance)
- **Zero Secrets in Code/Git:** No API keys in client-side code, Git history, network responses, or build artifacts.
- **Server-side Environment Variables:** All sensitive API keys (e.g., Gemini API key) MUST reside strictly in serverless environment variables (`process.env.GEMINI_API_KEY`).

---

## 3. Detailed Requirements & Features

### Feature A: Real-Time Exchange Rate & Daily History
1. **Live Data Display:**
   - Display real-time USD/KRW and JPY/KRW values, currency units, data source, source timestamp, fetch timestamp, and time zone (KST).
   - Compute and display difference/trend relative to yesterday's rate.
2. **Date-Based Deduplication (KST):**
   - Use KST date as the primary key.
   - Multiple successful fetches on the same KST date must update the current state but only produce **1 daily history record**.
   - Successful fetches on a new KST date append a **new daily history record**.
   - Maintain 2 distinct KST date history records for comparison tests.

### Feature B: Failure Resilience & Synthetic Error Simulation
Implement 5 synthetic failure modes to test robustness without losing valid historical data:
1. **Synthetic Failure Cases:**
   - `Slow External Response` (Timeout)
   - `401 / 403 Unauthorized`
   - `Rate Limit Exceeded`
   - `Offline / Network Failure`
   - `Response Schema Mismatch`
2. **Data Preservation & UI State:**
   - When a failure occurs, **do NOT delete** the last known valid values.
   - UI must update to show an **"error / stale"** indicator next to the preserved last valid values.
   - Distinct, descriptive failure messages and user action guidance must be displayed based on error type.
3. **Recovery Action (`T04-RECOVER-D2`):**
   - Provide a retry action button.
   - Executing asset `T04-RECOVER-D2` resets state to `fresh`, sets `error_code` to `none`, and correctly appends the next day's daily record.

### Feature C: Context-Aware AI Chatbot
1. **Mechanism:**
   - User inputs questions like *"Why did the exchange rate go up today?"*.
   - Frontend captures the user query along with current exchange rate context (e.g., USD: 1,385 KRW, +8 KRW change, status: `fresh`).
   - Request is sent to the Vercel Serverless Function, which constructs an enriched prompt and calls the Gemini API.
2. **Prompt Strategy:**
   - Prompt format: `[Current Rate Data] + [User Query] + [Instruction to infer general economic reasons in 2-3 concise sentences for beginners]`.
3. **Error Handling:**
   - If the chatbot API fails or goes offline, display a clear fallback notice: *"Unable to load AI analysis. Please check the last valid exchange rate data."*

---

## 4. Troubleshooting Checklist (Verification Steps)
When facing identical error rendering:
1. Separate HTTP Status vs Timeout issues.
2. Verify Response Schema.
3. Isolate Offline status.

---

## 5. Artifacts to Deliver
- **Public Package ID & File Hash Verification:** Support SHA-256 hash checks on assets.
- **5 Failure Modes Handled:** All synthetic cases correctly mapped to UI states.
- **Data Preservation:** Verification of Last Valid Value retention, Stale Indicator, Retry Action, and Recovery.

---

## 6. Implementation Guide for Claude Code

```bash
# Recommended Prompt for Claude Code:
"Read project_specification.md. Implement a web dashboard that tracks real-time exchange rates (USD, JPY) using a keyless API, satisfies all synthetic failure simulation and last-value retention requirements from Task 04, and includes a Vercel serverless proxy route for a Gemini AI chatbot without exposing any API keys."
```