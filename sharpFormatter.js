// sharpFormatter.js
export function formatSharpAlert(alert) {
  if (!alert) return null;

  const { render, game, lines, recommendation, sharp_side, score, signals } = alert;

  let msg = `${render.emoji} *${render.title}*\n\n`;

  msg += `📅 ${new Date(game.start_time_utc).toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric"
  })} ET\n`;
  msg += `⚔️ ${game.away} @ ${game.home}\n\n`;

  msg += `🎯 Sharp Side: *${sharp_side.team || "Split"}*\n`;
  msg += `📊 Score: ${score} (${render.strength})\n`;
  msg += `🏷️ Signals: ${signals.map((s) => s.label).join(", ")}\n\n`;

  msg += `📈 Entry: ${lines.sharp_entry}\n`;
  msg += `📉 Current: ${lines.current_consensus}\n`;

  msg += `\n✅ *Recommendation*: ${recommendation.status}\n_${recommendation.reason}_`;

  return msg.trim();
}
