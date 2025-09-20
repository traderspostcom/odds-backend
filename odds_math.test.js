import { ipFromAmerican, amFromIp, evAmerican, bestLinesAndMetrics } from "./odds_math.js";

describe("Odds Math Utilities", () => {
  test("ipFromAmerican works correctly", () => {
    expect(ipFromAmerican(-110).toFixed(3)).toBe("0.524");
    expect(ipFromAmerican(+200).toFixed(3)).toBe("0.333");
  });

  test("amFromIp works correctly", () => {
    expect(Math.round(amFromIp(0.5))).toBe(100);    // 50% → +100
    expect(Math.round(amFromIp(0.75))).toBe(-300);  // 75% → -300
  });

  test("evAmerican calculates expected value", () => {
    const ev = evAmerican(-110, 0.55); // 55% model probability
    expect(ev).toBeCloseTo(0.014, 3); // small +EV
  });

  test("bestLinesAndMetrics returns hold + devig", () => {
    const fakeGame = {
      bookmakers: [
        {
          title: "Book1",
          markets: [
            {
              key: "h2h",
              outcomes: [
                { name: "TeamA", price: -110 },
                { name: "TeamB", price: +100 }
              ]
            }
          ]
        }
      ]
    };

    const metrics = bestLinesAndMetrics(fakeGame);
    expect(metrics).toHaveProperty("hold");
    expect(metrics).toHaveProperty("devig");
    expect(Object.keys(metrics.best)).toContain("TeamA");
    expect(Object.keys(metrics.best)).toContain("TeamB");
  });
});
