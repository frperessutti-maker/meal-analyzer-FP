# 🍽️ Meal Analyzer

AI-powered daily nutrition tracker with photo and text meal analysis.

## Features
- **Photo analysis** — snap a photo, Claude identifies ingredients and portions
- **Text input** — type what you ate with approximate portions
- **Saved meals** — save recurring meals for one-tap logging
- **10-day history** — track deficiencies over time with averages and alerts
- **Full nutrition** — calories, protein, fat, carbs, fiber + 10 micronutrients
- **Athlete-optimized** — targets set for active training (customizable)

## Setup

### 1. Deploy the API proxy (Cloudflare Worker — free)

1. Go to [workers.cloudflare.com](https://workers.cloudflare.com) and create an account
2. Create a new Worker
3. Paste the contents of `worker.js`
4. Save and Deploy
5. Go to **Settings → Variables** → Add `ANTHROPIC_API_KEY` as a **Secret**
6. Copy your worker URL (e.g. `https://meal-analyzer.yourname.workers.dev`)

### 2. Open the app

The app is hosted via GitHub Pages at:
**https://YOUR_USERNAME.github.io/meal-analyzer/**

### 3. Connect

Paste your Cloudflare Worker URL in the setup screen → done.

## Cost
- Cloudflare Worker: **free** (100K requests/day)
- Claude API: ~**$0.003 per meal** analyzed (Sonnet)

## Privacy
All data stored locally in your browser. Only meal descriptions are sent to Claude for analysis.
