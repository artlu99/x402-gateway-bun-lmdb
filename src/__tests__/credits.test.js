import { describe, expect, test } from "bun:test";
import { decrementCredit, getCreditCount,incrementCredit } from "../utils/store";

describe("Credits (LMDB)", () => {
	test("incrementCredit increases count up to cap", async () => {
		const payer = `0xPAYER_${Date.now()}`;
		const routeKey = "myapi";

		const one = await incrementCredit(payer, routeKey, 3, 60);
		const two = await incrementCredit(payer, routeKey, 3, 60);
		const three = await incrementCredit(payer, routeKey, 3, 60);
		const stillThree = await incrementCredit(payer, routeKey, 3, 60);

		expect(one).toBe(1);
		expect(two).toBe(2);
		expect(three).toBe(3);
		expect(stillThree).toBe(3);

		const count = await getCreditCount(payer, routeKey);
		expect(count).toBe(3);
	});

	test("decrementCredit consumes credits and deletes key at zero", async () => {
		const payer = `0xPAYER_${Date.now()}`;
		const routeKey = "route-a";

		await incrementCredit(payer, routeKey, 10, 60);
		await incrementCredit(payer, routeKey, 10, 60);
		expect(await getCreditCount(payer, routeKey)).toBe(2);

		expect(await decrementCredit(payer, routeKey)).toBe(true);
		expect(await getCreditCount(payer, routeKey)).toBe(1);

		expect(await decrementCredit(payer, routeKey)).toBe(true);
		expect(await getCreditCount(payer, routeKey)).toBe(0);

		// No credit left
		expect(await decrementCredit(payer, routeKey)).toBe(false);
	});

	test("credits expire via lazy expiry on read", async () => {
		const payer = `0xPAYER_${Date.now()}`;
		const routeKey = "route-expire";

		await incrementCredit(payer, routeKey, 10, 1);
		expect(await getCreditCount(payer, routeKey)).toBe(1);

		// Wait for TTL to elapse; expiry is enforced on read/decrement/increment.
		await Bun.sleep(1100);
		expect(await getCreditCount(payer, routeKey)).toBe(0);
	});

	test("incrementCredit refreshes TTL even when at cap", async () => {
		const payer = `0xPAYER_${Date.now()}`;
		const routeKey = "route-ttl-refresh";

		// Cap at 1 credit, ttl=1s
		expect(await incrementCredit(payer, routeKey, 1, 1)).toBe(1);
		expect(await getCreditCount(payer, routeKey)).toBe(1);

		// Wait a bit, then "increment" again at cap; should keep count at 1 but refresh TTL.
		await Bun.sleep(700);
		expect(await incrementCredit(payer, routeKey, 1, 1)).toBe(1);

		// If TTL was NOT refreshed, we'd now be past the original 1s expiry.
		await Bun.sleep(700);
		expect(await getCreditCount(payer, routeKey)).toBe(1);

		// Now allow refreshed TTL to expire.
		await Bun.sleep(1100);
		expect(await getCreditCount(payer, routeKey)).toBe(0);
	});

	test("decrementCredit is atomic under concurrent calls (only one consumer wins)", async () => {
		const payer = `0xPAYER_${Date.now()}`;
		const routeKey = "route-atomic";

		await incrementCredit(payer, routeKey, 10, 60);
		expect(await getCreditCount(payer, routeKey)).toBe(1);

		const results = await Promise.all(
			Array.from({ length: 10 }, () => decrementCredit(payer, routeKey)),
		);
		const winners = results.filter(Boolean).length;

		expect(winners).toBe(1);
		expect(await getCreditCount(payer, routeKey)).toBe(0);
	});
});

