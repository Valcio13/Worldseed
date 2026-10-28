import { createInterface } from 'node:readline/promises';
import { env, stdin, stdout } from 'node:process';
import { encodeDeployData, getAddress, isAddress, keccak256, zeroAddress } from 'viem';
import { artifacts, network } from 'hardhat';

const EXPECTED_CHAIN_ID = 743111;
const CONTRACT_NAME = 'WorldseedGameV3';

function requiredAddress(name: string): `0x${string}` {
  const value = env[name]?.trim();
  if (!value || !isAddress(value)) {
    throw new Error(`${name} must be set to a valid public Ethereum address.`);
  }
  const address = getAddress(value);
  if (address === zeroAddress) throw new Error(`${name} cannot be the zero address.`);
  return address;
}

async function main() {
  const owner = requiredAddress('WORLDSEED_V3_OWNER_ADDRESS');
  const attester = requiredAddress('WORLDSEED_V3_ATTESTER_ADDRESS');
  if (owner.toLowerCase() === attester.toLowerCase()) {
    throw new Error('Owner and attester addresses must be different.');
  }

  const mode = env.WORLDSEED_V3_MODE?.trim().toLowerCase() || 'simulate';
  if (mode !== 'simulate' && mode !== 'deploy') {
    throw new Error('WORLDSEED_V3_MODE must be either "simulate" or "deploy".');
  }

  // Simulation always uses an isolated in-memory Hardhat network. Deploy mode
  // connects only to the named Hemi Sepolia network and checks its chain ID.
  const connection =
    mode === 'simulate' ? await network.create() : await network.connect('hemiSepolia');
  const publicClient = await connection.viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  if (mode === 'deploy' && chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `Refusing to deploy: connected chain ID ${chainId}; expected Hemi Sepolia (${EXPECTED_CHAIN_ID}).`,
    );
  }

  const [deployer] = await connection.viem.getWalletClients({ count: 1 });
  const artifact = await artifacts.readArtifact(CONTRACT_NAME);
  const initCode = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode as `0x${string}`,
    args: [owner, attester],
  });
  const estimatedGas = await publicClient.estimateGas({
    account: deployer.account,
    data: initCode,
  });
  const gasPrice = await publicClient.getGasPrice();

  console.log(
    `Mode: ${mode === 'simulate' ? 'local simulation (no external network)' : 'Hemi Sepolia deployment'}`,
  );
  console.log(`Network chain ID: ${chainId}`);
  console.log(`Expected chain ID: ${EXPECTED_CHAIN_ID}`);
  console.log(`Deployer: ${deployer.account.address}`);
  console.log(`Constructor owner_: ${owner}`);
  console.log(`Constructor attester_: ${attester}`);
  console.log('Constructor order: owner_, attester_');
  console.log(
    `Creation bytecode hash (keccak256): ${keccak256(artifact.bytecode as `0x${string}`)}`,
  );
  console.log(
    `Deployment initcode hash (keccak256, includes constructor args): ${keccak256(initCode)}`,
  );
  console.log(`Estimated deployment gas: ${estimatedGas}`);
  console.log(`Estimated execution fee at current gas price: ${estimatedGas * gasPrice} wei`);
  if (mode === 'deploy') {
    console.log('Estimate excludes any chain-specific L1 data fee shown by the wallet/RPC.');
  }

  if (mode === 'simulate') {
    const { contract, deploymentTransaction } = await connection.viem.sendDeploymentTransaction(
      CONTRACT_NAME,
      [owner, attester],
      { client: { public: publicClient, wallet: deployer } },
    );
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: deploymentTransaction.hash,
    });
    if (receipt.status !== 'success') throw new Error('Local simulation deployment reverted.');
    const [deployedOwner, deployedAttester] = await Promise.all([
      contract.read.owner(),
      contract.read.attester(),
    ]);
    if (getAddress(deployedOwner) !== owner || getAddress(deployedAttester) !== attester) {
      throw new Error('Local simulation constructor verification failed.');
    }
    console.log('Local simulation: successful (in-memory only; no Hemi transaction submitted).');
    console.log(`Simulated contract address: ${contract.address}`);
    console.log(`Simulated deployment gas used: ${receipt.gasUsed}`);
    return;
  }

  const confirmation = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await confirmation.question(
      'Type DEPLOY HEMI SEPOLIA to submit this deployment transaction: ',
    );
    if (answer.trim() !== 'DEPLOY HEMI SEPOLIA') {
      console.log('Cancelled. No deployment transaction submitted.');
      return;
    }
  } finally {
    confirmation.close();
  }

  const { contract, deploymentTransaction } = await connection.viem.sendDeploymentTransaction(
    CONTRACT_NAME,
    [owner, attester],
    { client: { public: publicClient, wallet: deployer } },
  );
  console.log(`Deployment transaction submitted: ${deploymentTransaction.hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: deploymentTransaction.hash,
  });
  if (receipt.status !== 'success')
    throw new Error(`Deployment reverted: ${deploymentTransaction.hash}`);

  const [deployedOwner, deployedAttester, deployedChainId] = await Promise.all([
    contract.read.owner(),
    contract.read.attester(),
    publicClient.getChainId(),
  ]);
  if (
    deployedChainId !== EXPECTED_CHAIN_ID ||
    getAddress(deployedOwner) !== owner ||
    getAddress(deployedAttester) !== attester
  ) {
    throw new Error(
      'Post-deployment verification failed; preserve the transaction details and investigate.',
    );
  }
  console.log(`Verified Hemi Sepolia deployment: ${contract.address}`);
  console.log(`Receipt status: ${receipt.status}`);
  console.log(`Block: ${receipt.blockNumber}`);
  console.log(`Gas used: ${receipt.gasUsed}`);
  console.log(`On-chain owner(): ${deployedOwner}`);
  console.log(`On-chain attester(): ${deployedAttester}`);
}

await main();
