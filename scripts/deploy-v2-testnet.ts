import { isAddress, parseAbi } from 'viem';
import { network } from 'hardhat';
import { env } from 'node:process';

const owner = env.HEMI_V2_OWNER_ADDRESS;
const attester = env.WORLDSEED_ATTESTER_ADDRESS;
if (!owner || !isAddress(owner) || !attester || !isAddress(attester)) {
  throw new Error('Set HEMI_V2_OWNER_ADDRESS and WORLDSEED_ATTESTER_ADDRESS before deployment.');
}
if (owner.toLowerCase() === attester.toLowerCase()) {
  throw new Error('Use separate owner and candidate-attester addresses for Contract V2.');
}

const connection = await network.connect('hemiSepolia');
const publicClient = await connection.viem.getPublicClient();
const chainId = await publicClient.getChainId();
if (chainId !== 743111) {
  throw new Error(
    `Refusing deployment on unexpected chain ${chainId}; expected Hemi Sepolia (743111).`,
  );
}

const { contract, deploymentTransaction } = await connection.viem.sendDeploymentTransaction(
  'WorldseedGameV2',
  [owner, attester],
);
const receipt = await publicClient.waitForTransactionReceipt({ hash: deploymentTransaction.hash });
if (receipt.status !== 'success')
  throw new Error(`V2 deployment failed: ${deploymentTransaction.hash}`);
const rolesAbi = parseAbi([
  'function owner() view returns (address)',
  'function attester() view returns (address)',
]);
const deployedOwner = await publicClient.readContract({
  address: contract.address,
  abi: rolesAbi,
  functionName: 'owner',
});
const deployedAttester = await publicClient.readContract({
  address: contract.address,
  abi: rolesAbi,
  functionName: 'attester',
});
if (
  deployedOwner.toLowerCase() !== owner.toLowerCase() ||
  deployedAttester.toLowerCase() !== attester.toLowerCase()
)
  throw new Error('Deployed owner/attester roles do not match the requested addresses.');

console.log(`Network: Hemi Sepolia (chain ${chainId})`);
console.log(`WorldseedGameV2 address: ${contract.address}`);
console.log(`Deployment transaction: ${deploymentTransaction.hash}`);
console.log(`Deployment gas used: ${receipt.gasUsed}`);
console.log(`Deployment block: ${receipt.blockNumber}`);
console.log(`Owner: ${deployedOwner}`);
console.log(`Attester: ${deployedAttester}`);
