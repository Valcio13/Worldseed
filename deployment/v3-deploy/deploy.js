/* global document, window */
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  encodeDeployData,
  formatEther,
  isAddress,
} from 'viem';
import artifact from '../../artifacts/contracts/WorldseedGameV3.sol/WorldseedGameV3.json';

const HEMI_SEPOLIA_ID = 743111;
const explorerBase = 'https://testnet.explorer.hemi.xyz';
const hemiSepolia = defineChain({
  id: HEMI_SEPOLIA_ID,
  name: 'Hemi Sepolia',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

const $ = (id) => document.getElementById(id);
const connectButton = $('connect');
const reviewButton = $('review');
const deployButton = $('deploy');
const ownerInput = $('owner');
const attesterInput = $('attester');
const reviewPanel = $('review-panel');
const confirmInput = $('confirm');
const statusText = $('status');
const walletStatus = $('wallet-status');
let provider;
let walletClient;
let publicClient;
let connectedAccount;
let approvedReview;
let busy = false;

function setStatus(message, kind = 'info') {
  statusText.textContent = message;
  statusText.dataset.kind = kind;
}

function constructorAddresses() {
  const owner = ownerInput.value.trim();
  const attester = attesterInput.value.trim();
  if (!isAddress(owner) || !isAddress(attester))
    throw new Error('Enter valid EVM addresses for both owner and attester.');
  if (owner.toLowerCase() === attester.toLowerCase())
    throw new Error('Owner and attester must be different addresses.');
  if (owner.toLowerCase() !== connectedAccount?.toLowerCase())
    throw new Error('The owner must match the connected deployment wallet.');
  return { owner, attester };
}

function invalidateReview() {
  approvedReview = undefined;
  reviewPanel.hidden = true;
  confirmInput.checked = false;
  deployButton.disabled = true;
}

async function connectWallet() {
  if (!window.ethereum)
    throw new Error('MetaMask or another EIP-1193 browser wallet was not found.');
  provider = window.ethereum;
  const [account] = await provider.request({ method: 'eth_requestAccounts' });
  if (!account || !isAddress(account))
    throw new Error('The wallet did not return a valid account.');
  connectedAccount = account;
  walletClient = createWalletClient({ chain: hemiSepolia, transport: custom(provider) });
  publicClient = createPublicClient({ chain: hemiSepolia, transport: custom(provider) });
  ownerInput.value = account;
  walletStatus.textContent = `Connected deployment account: ${account}`;
  reviewButton.disabled = false;
  invalidateReview();
  setStatus('Wallet connected. Check the network and review the deployment details.');
}

async function reviewDeployment() {
  if (!provider || !publicClient || !connectedAccount) throw new Error('Connect a wallet first.');
  const { owner, attester } = constructorAddresses();
  const chainId = await walletClient.getChainId();
  if (chainId !== HEMI_SEPOLIA_ID)
    throw new Error(
      `Wrong network: wallet reports chain ID ${chainId}. Switch MetaMask to Hemi Sepolia (743111), then retry.`,
    );

  const bytecode = artifact.bytecode;
  if (!bytecode || bytecode === '0x')
    throw new Error('Compiled creation bytecode is missing from the Hardhat artifact.');
  const data = encodeDeployData({ abi: artifact.abi, bytecode, args: [owner, attester] });
  const [gas, gasPrice, balance] = await Promise.all([
    publicClient.estimateGas({ account: owner, data }),
    publicClient.getGasPrice(),
    publicClient.getBalance({ address: owner }),
  ]);
  const estimate = gas * gasPrice;
  approvedReview = { owner, attester, account: connectedAccount, chainId, data, gas, gasPrice };

  const rows = [
    ['Network', 'Hemi Sepolia (743111)'],
    ['Connected deployer / owner', owner],
    ['Attester', attester],
    ['Contract', artifact.contractName],
    ['Compiler', 'Solidity 0.8.24 · optimizer 500 · viaIR · Shanghai'],
    ['Creation bytecode', `${(bytecode.length - 2) / 2} bytes`],
    ['Estimated gas', gas.toString()],
    ['Estimated fee at current gas price', `${formatEther(estimate)} ETH`],
    ['Current wallet balance', `${formatEther(balance)} ETH`],
  ];
  $('details').replaceChildren(
    ...rows.flatMap(([term, description]) => {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = term;
      dd.textContent = description;
      return [dt, dd];
    }),
  );
  reviewPanel.hidden = false;
  deployButton.disabled = !confirmInput.checked;
  setStatus(
    'Preflight passed. Review the details, confirm the checkbox, then explicitly choose Deploy with MetaMask.',
  );
}

async function deployContract() {
  if (!approvedReview || !walletClient || !publicClient)
    throw new Error('Review the deployment details again first.');
  const { owner, attester } = constructorAddresses();
  const chainId = await walletClient.getChainId();
  const [account] = await walletClient.getAddresses();
  if (
    chainId !== HEMI_SEPOLIA_ID ||
    account?.toLowerCase() !== owner.toLowerCase() ||
    approvedReview.owner.toLowerCase() !== owner.toLowerCase() ||
    approvedReview.attester.toLowerCase() !== attester.toLowerCase() ||
    approvedReview.chainId !== chainId
  ) {
    invalidateReview();
    throw new Error(
      'Wallet network, account, or constructor inputs changed after review. Run preflight again.',
    );
  }

  setStatus('MetaMask will ask you to review and approve the Hemi Sepolia deployment transaction.');
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [owner, attester],
    account: owner,
    chain: hemiSepolia,
  });
  setStatus(`Transaction submitted: ${hash}. Waiting for the Hemi Sepolia receipt…`);
  deployButton.disabled = true;
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress)
    throw new Error(
      `Deployment receipt failed or omitted the contract address. Transaction: ${hash}`,
    );

  const [onchainOwner, onchainAttester, deployedBytecode] = await Promise.all([
    publicClient.readContract({
      address: receipt.contractAddress,
      abi: artifact.abi,
      functionName: 'owner',
    }),
    publicClient.readContract({
      address: receipt.contractAddress,
      abi: artifact.abi,
      functionName: 'attester',
    }),
    publicClient.getCode({ address: receipt.contractAddress }),
  ]);
  if (
    onchainOwner.toLowerCase() !== owner.toLowerCase() ||
    onchainAttester.toLowerCase() !== attester.toLowerCase() ||
    deployedBytecode?.toLowerCase() !== artifact.deployedBytecode.toLowerCase()
  )
    throw new Error(
      `Receipt succeeded, but onchain owner, attester, or runtime bytecode did not match. Address: ${receipt.contractAddress}; tx: ${hash}`,
    );

  const explorerLink = $('explorer');
  explorerLink.href = `${explorerBase}/address/${receipt.contractAddress}`;
  explorerLink.hidden = false;
  setStatus(
    `Verified deployment. Address ${receipt.contractAddress}; transaction ${hash}; block ${receipt.blockNumber}; gas used ${receipt.gasUsed}. Onchain owner and attester match the reviewed inputs, and runtime bytecode matches the compiled artifact.`,
    'success',
  );
  approvedReview = undefined;
}

async function guarded(action) {
  if (busy) return;
  busy = true;
  connectButton.disabled = true;
  reviewButton.disabled = true;
  if (action === deployContract) deployButton.disabled = true;
  try {
    await action();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Operation failed.', 'error');
  } finally {
    busy = false;
    connectButton.disabled = false;
    reviewButton.disabled = !connectedAccount;
    deployButton.disabled = !(approvedReview && confirmInput.checked);
  }
}

connectButton.addEventListener('click', () => guarded(connectWallet));
reviewButton.addEventListener('click', () => guarded(reviewDeployment));
deployButton.addEventListener('click', () => guarded(deployContract));
confirmInput.addEventListener('change', () => {
  deployButton.disabled = !(approvedReview && confirmInput.checked && !busy);
});
for (const input of [ownerInput, attesterInput]) input.addEventListener('input', invalidateReview);

if (window.ethereum?.on) {
  window.ethereum.on('accountsChanged', () => {
    connectedAccount = undefined;
    walletClient = undefined;
    publicClient = undefined;
    walletStatus.textContent = 'Wallet account changed. Reconnect and review again.';
    reviewButton.disabled = true;
    invalidateReview();
  });
  window.ethereum.on('chainChanged', () => {
    invalidateReview();
    walletStatus.textContent = 'Wallet network changed. Recheck the network before deployment.';
  });
}
