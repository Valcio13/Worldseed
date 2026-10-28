import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { env, stdin, stdout } from 'node:process';
import type {} from '@nomicfoundation/hardhat-viem';
import { encodeDeployData, getAddress, isAddress, keccak256, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { artifacts, network } from 'hardhat';

const EXPECTED_CHAIN_ID = 43111;
const CONTRACT_NAME = 'WorldseedGameV3';
const EXPECTED_ACTIVE_RULES_VERSION = 3;
const EXPECTED_V3_REWARD_RULES = [42, 10, 1_000, 1, 100_000, 100_000, 100, 7] as const;

interface V3GenesisReader {
  read: {
    owner(): Promise<`0x${string}`>;
    attester(): Promise<`0x${string}`>;
    activeRulesVersion(): Promise<number | bigint>;
    rewardRules(args: [number]): Promise<readonly (number | bigint)[]>;
  };
}

interface ChainIdReader {
  getChainId(): Promise<number>;
}

interface BuildInfo {
  input: {
    sources: Record<string, { content: string }>;
    settings: {
      optimizer?: { enabled?: boolean; runs?: number };
      viaIR?: boolean;
      evmVersion?: string;
    };
  };
  solcVersion: string;
}

async function assertFreshProductionArtifact(artifact: {
  sourceName: string;
  inputSourceName?: string;
  buildInfoId?: string;
  bytecode: string;
}) {
  const buildInfoId = artifact.buildInfoId;
  if (!buildInfoId) throw new Error('Contract artifact has no Hardhat build-info reference.');
  const buildInfoPath = await artifacts.getBuildInfoPath(buildInfoId);
  const outputPath = await artifacts.getBuildInfoOutputPath(buildInfoId);
  if (!buildInfoPath || !outputPath)
    throw new Error(
      'Contract artifact build info is missing; compile the production profile first.',
    );

  const buildInfo = JSON.parse(await readFile(buildInfoPath, 'utf8')) as BuildInfo;
  const output = JSON.parse(await readFile(outputPath, 'utf8')) as {
    output?: {
      contracts?: Record<string, Record<string, { evm?: { bytecode?: { object?: string } } }>>;
    };
  };
  const sourceName = artifact.inputSourceName ?? artifact.sourceName;
  const compiledSource = buildInfo.input.sources[sourceName]?.content;
  const currentSource = await readFile(
    new URL('../contracts/WorldseedGameV3.sol', import.meta.url),
    'utf8',
  );
  const normalizeNewlines = (text: string) => text.replace(/\r\n/g, '\n');
  const compiledBytecode =
    output.output?.contracts?.[sourceName]?.[CONTRACT_NAME]?.evm?.bytecode?.object;

  const checks = {
    compiler: buildInfo.solcVersion === '0.8.24',
    optimizer: buildInfo.input.settings.optimizer?.enabled === true,
    optimizerRuns: buildInfo.input.settings.optimizer?.runs === 500,
    viaIR: buildInfo.input.settings.viaIR === true,
    evmVersion: buildInfo.input.settings.evmVersion === 'shanghai',
    sourcePresent: Boolean(compiledSource),
    sourceCurrent: Boolean(
      compiledSource && normalizeNewlines(compiledSource) === normalizeNewlines(currentSource),
    ),
    bytecodePresent: Boolean(compiledBytecode),
    bytecodeMatches: Boolean(compiledBytecode && `0x${compiledBytecode}` === artifact.bytecode),
  };
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failedChecks.length > 0)
    throw new Error(
      `Refusing deployment: artifact validation failed (${failedChecks.join(', ')}).`,
    );
}

async function verifyGenesis(
  contract: V3GenesisReader,
  owner: string,
  attester: string,
  publicClient: ChainIdReader,
) {
  const [deployedOwner, deployedAttester, chainId, activeRulesVersion, rewardRules] =
    await Promise.all([
      contract.read.owner(),
      contract.read.attester(),
      publicClient.getChainId(),
      contract.read.activeRulesVersion(),
      contract.read.rewardRules([EXPECTED_ACTIVE_RULES_VERSION]),
    ]);
  if (
    chainId !== EXPECTED_CHAIN_ID ||
    getAddress(deployedOwner) !== owner ||
    getAddress(deployedAttester) !== attester ||
    Number(activeRulesVersion) !== EXPECTED_ACTIVE_RULES_VERSION ||
    !EXPECTED_V3_REWARD_RULES.every((value, index) => Number(rewardRules[index]) === value)
  ) {
    throw new Error(
      'Post-deployment verification failed for network, roles, or Rules V3 genesis config.',
    );
  }
  return { deployedOwner, deployedAttester, activeRulesVersion, rewardRules };
}

function requiredAddress(name: string): `0x${string}` {
  const value = env[name]?.trim();
  if (!value || !isAddress(value)) throw new Error(`${name} must be a valid public address.`);
  const address = getAddress(value);
  if (address === zeroAddress) throw new Error(`${name} cannot be the zero address.`);
  return address;
}

function requiredAttesterKey(name: string): `0x${string}` {
  const value = env[name]?.trim();
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error(`${name} must be configured as a local private setting.`);
  return value as `0x${string}`;
}

async function main() {
  const owner = requiredAddress('WORLDSEED_V3_MAINNET_OWNER_ADDRESS');
  const attester = requiredAddress('WORLDSEED_V3_MAINNET_ATTESTER_ADDRESS');
  const attesterKey = requiredAttesterKey('WORLDSEED_V3_MAINNET_ATTESTER_PRIVATE_KEY');
  const derivedAttester = getAddress(privateKeyToAccount(attesterKey).address);
  if (owner.toLowerCase() === attester.toLowerCase())
    throw new Error('Mainnet owner and attester must be different addresses.');
  if (derivedAttester.toLowerCase() !== attester.toLowerCase())
    throw new Error('Configured Mainnet attester address does not match its signing key.');

  const mode = env.WORLDSEED_V3_MAINNET_MODE?.trim().toLowerCase() || 'simulate';
  if (mode !== 'simulate' && mode !== 'deploy')
    throw new Error('WORLDSEED_V3_MAINNET_MODE must be "simulate" or "deploy".');

  const connection =
    mode === 'simulate' ? await network.create() : await network.connect('hemiMainnet');
  const publicClient = await connection.viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  if (mode === 'deploy' && chainId !== EXPECTED_CHAIN_ID)
    throw new Error(
      `Refusing deployment: connected chain ${chainId}, expected Hemi Mainnet (${EXPECTED_CHAIN_ID}).`,
    );

  const [deployer] = await connection.viem.getWalletClients();
  const deployerAddress = getAddress(deployer.account.address);
  if (owner.toLowerCase() === deployerAddress.toLowerCase())
    throw new Error('Mainnet owner and deployer must be different addresses.');
  if (attester.toLowerCase() === deployerAddress.toLowerCase())
    throw new Error('Mainnet attester and deployer must be different addresses.');
  const artifact = await artifacts.readArtifact(CONTRACT_NAME);
  await assertFreshProductionArtifact(artifact);
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
  const estimatedFee = estimatedGas * gasPrice;
  const deployerBalance = await publicClient.getBalance({ address: deployer.account.address });
  if (mode === 'deploy' && deployerBalance < estimatedFee) {
    throw new Error('Mainnet deployer balance is below the estimated deployment fee.');
  }
  console.log(`Mode: ${mode === 'simulate' ? 'local simulation' : 'Hemi Mainnet deployment'}`);
  console.log(`Chain ID: ${chainId}; expected: ${EXPECTED_CHAIN_ID}`);
  console.log(`Deployer: ${deployerAddress}`);
  console.log(`Constructor owner_: ${owner}`);
  console.log(`Constructor attester_: ${attester}`);
  console.log(`Attester key address match: ${derivedAttester === attester}`);
  console.log(`Creation bytecode hash: ${keccak256(artifact.bytecode as `0x${string}`)}`);
  console.log(`Deployment initcode hash: ${keccak256(initCode)}`);
  console.log(`Deployer balance: ${deployerBalance} wei`);
  console.log(`Estimated gas: ${estimatedGas}; execution fee: ${estimatedFee} wei`);
  console.log(
    `Expected genesis rules: active version ${EXPECTED_ACTIVE_RULES_VERSION}; tuple ${EXPECTED_V3_REWARD_RULES.join(',')}`,
  );

  if (mode === 'simulate') {
    const { contract, deploymentTransaction } = await connection.viem.sendDeploymentTransaction(
      CONTRACT_NAME,
      [owner, attester],
      { client: { public: publicClient, wallet: deployer } },
    );
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: deploymentTransaction.hash,
    });
    if (receipt.status !== 'success') throw new Error('Local deployment simulation reverted.');
    const verified = await verifyGenesis(
      contract as unknown as V3GenesisReader,
      owner,
      attester,
      publicClient,
    );
    console.log(
      `Local simulation succeeded; address: ${contract.address}; gas used: ${receipt.gasUsed}; active rules: ${verified.activeRulesVersion}`,
    );
    return;
  }

  const confirmation = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await confirmation.question('Type DEPLOY WORLDSEED V3 MAINNET to submit: ');
    if (answer.trim() !== 'DEPLOY WORLDSEED V3 MAINNET') {
      console.log('Cancelled; no transaction submitted.');
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
  console.log(`Deployment transaction: ${deploymentTransaction.hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: deploymentTransaction.hash,
  });
  if (receipt.status !== 'success') throw new Error('Mainnet deployment reverted.');
  const verified = await verifyGenesis(
    contract as unknown as V3GenesisReader,
    owner,
    attester,
    publicClient,
  );
  console.log(`Contract: ${contract.address}`);
  console.log(`Receipt: ${receipt.status}; block ${receipt.blockNumber}; gas ${receipt.gasUsed}`);
  console.log(
    `owner(): ${verified.deployedOwner}; attester(): ${verified.deployedAttester}; activeRulesVersion(): ${verified.activeRulesVersion}; rewardRules(3): ${EXPECTED_V3_REWARD_RULES.join(',')}`,
  );
}

await main();
