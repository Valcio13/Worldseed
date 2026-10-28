# Owner-operated V3 deployment page

This is a local, standalone Vite page. It uses the compiled Hardhat artifact in `artifacts/`; it does not alter the game site, use a private key, or deploy automatically.

## Run

From the repository root:

```powershell
npx vite deployment/v3-deploy --host 127.0.0.1 --port 5179 --strictPort
```

Open `http://127.0.0.1:5179/`. Keep the terminal open while using the page. Stop it with `Ctrl+C` when finished.

## Manual deployment

1. Ensure the final production artifact exists by running `npm run contract:compile` from the repository root.
2. Configure MetaMask for Hemi Sepolia (chain ID `743111`) and connect the intended owner wallet. The page uses the wallet's current RPC provider; it does not attempt a network switch.
3. Connect MetaMask on the local page. Enter the owner and attester addresses. The page requires the owner to match the connected account and the attester to be a different valid address.
4. Choose **Check network and review**. The page checks chain ID, estimates deployment gas and fee, reads the wallet balance, and displays the fixed artifact and constructor values.
5. Review every displayed value and check the confirmation box. Only then does **Deploy with MetaMask** become available.
6. Select that button to open MetaMask. Review the transaction there and approve it yourself. Rejecting the wallet prompt submits nothing.
7. After confirmation, the page checks the receipt, onchain `owner()` and `attester()`, and deployed runtime bytecode against the compiled artifact. Save the address and transaction hash shown by the page.

This page is for deployment only. It does not configure the verifier, Cloudflare, or the live game, and does not verify source code with an explorer.
