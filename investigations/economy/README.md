# Economy investigations

These files are temporary, reproducible simulations and comparison tests used during economy design. They are intentionally kept outside `src/`, so the standard `npm test` suite and production bundle do not include them. They import the production economy/rules implementation but do not change it.

Run a focused investigation test with:

```powershell
npx vitest run investigations/economy/<test-file>.test.ts
```

Run the verified economy script with:

```powershell
npx tsx investigations/economy/verifiedEconomyBalanceInvestigation.ts
```

These outputs are exploratory and do not constitute a balance approval.
