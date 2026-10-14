import { network } from 'hardhat';

const connection = await network.connect('hemiSepolia');
const publicClient = await connection.viem.getPublicClient();
const chainId = await publicClient.getChainId();
if (chainId !== 743111) {
  throw new Error(
    `Refusing deployment on unexpected chain ${chainId}; expected Hemi Sepolia (743111).`,
  );
}

const { contract, deploymentTransaction } =
  await connection.viem.sendDeploymentTransaction('WorldseedGame');
const receipt = await publicClient.waitForTransactionReceipt({ hash: deploymentTransaction.hash });

if (receipt.status !== 'success') {
  throw new Error(`Deployment failed: ${deploymentTransaction.hash}`);
}

console.log(`Network: Hemi Sepolia (chain ${chainId})`);
console.log(`WorldseedGame address: ${contract.address}`);
console.log(`Deployment transaction: ${deploymentTransaction.hash}`);
console.log(`Deployment gas used: ${receipt.gasUsed}`);
console.log(`Deployment block: ${receipt.blockNumber}`);
