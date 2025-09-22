// test-telegram.js
import { sendTelegramMessage, formatSharpBatch } from "./src/telegram.js";

// 👇 Replace this with your real Telegram chat ID
const TEST_CHAT_ID = process.env.TEST_TELEGRAM_CHAT_ID || "<YOUR_CHAT_ID_HERE>";

async function runTest() {
  try {
    // 1. Create a dummy game batch to test formatting
    const dummyGames = [
      {
        time: "TBD",
        away: "Washington Nationals",
        home: "Atlanta Braves",
        market: "totals1st5innings", // tests the new normalization
        hold: 0.0374,
        best: {
          O: { point: 4.5, book: "FanDuel", price: "-110" },
          U: { point: 4.5, book: "DraftKings", price: "-105" },
        },
      },
    ];

    // 2. Format into Telegram text
    const messages = formatSharpBatch(dummyGames);

    // 3. Send each message to Telegram
    for (const msg of messages) {
      console.log("Sending test message:\n", msg);
      await sendTelegramMessage(TEST_CHAT_ID, msg);
    }

    console.log("✅ Test message sent successfully!");
  } catch (err) {
    console.error("❌ Telegram test failed:", err);
  }
}

runTest();
