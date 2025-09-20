// odds_math.test.js
import { ipFromAmerican, evAmerican, bestLinesAndMetrics } from "./odds_math.js";

describe("odds_math.js", () => {
  test("ipFromAmerican converts positive odds correctly", () => {
    expect(ipFromAmerican(100)).toBeCloseTo(0.5, 5);   // +100 → 50%
    expect(ipFromAmerican(200)).toBeCloseTo(0.333, 3); // +200 → 33.3%
  });

  test("ipFromAmerican converts negative odds correctly", () => {
    expect(ipFromAmerican(-110)).toBeCloseTo(0.524, 3); // -110 → ~52.4%
    expect(ipFromAmerican(-200)).toBeCloseTo(0.667, 3); // -200 → 66.7%
  });

  test("evAmerican calculates expected value correctly", () => {
    // Example: +100 odds, model says 55% win probability
    const ev = evAmerican(100, 0.55);
    expect(ev).toBeCloseTo(0.05, 2); // small positive EV
  });

  test("bestLinesAndMetrics returns best prices and de-vig probabilities", () => {
    const mockGame = {
      bookmakers: [
        {
          title: "Book A",
          markets: [
            {
              key: "h2h",
              outcomes: [
                { name: "Team A", price: -110 },
                { name: "Team B", price: +100 }
              ]
            }
          ]
        },
        {
          title: "Book B",
          markets: [
            {
              key: "h2h",
              outcomes: [
                { name: "Team A", price: -105 },
                { name: "Team B", price: -105 }
              ]
            }
          ]
        }
      ]
    };

    const metrics = bestLinesAndMetrics(mockGame);

    expect(metrics).not.toBeNull();
    expect(metrics.best["Team A"].price).toBe(-105); // Best price for Team A
    expect(metrics.best["Team B"].price).toBe(100);  // Best price for Team B
    expect(metrics.devig["Team A"] + metrics.devig["Team B"]).toBeCloseTo(1, 5); // probabilities sum to 1
  });
});
