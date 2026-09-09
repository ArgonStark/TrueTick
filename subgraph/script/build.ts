import yargs from 'yargs'

import { build, deploy } from './utils/deploy-utils'
import { validateNetwork, validateSubgraphType } from './utils/prepareNetwork'

async function main(): Promise<void> {
  const argv = yargs(process.argv.slice(2))
    .option('network', {
      alias: 'n',
      description: 'Network to build for',
      type: 'string',
      demandOption: true,
    })
    .option('subgraph-type', {
      alias: 's',
      description: 'Type of the subgraph',
      type: 'string',
      demandOption: true,
    })
    .option('deploy', {
      alias: 'd',
      description: 'Deploy the subgraph',
      type: 'boolean',
      default: false,
    })
    // Upstream used `.argv`, which yargs 17 types as `T | Promise<T>`; every
    // property access below then fails to type-check under ts-node. parseSync()
    // is the same parse with the synchronous return type. Not part of the
    // Slipstream adaptation -- an upstream build-script bug.
    .help()
    .parseSync()
  validateNetwork(argv.network)
  validateSubgraphType(argv.subgraphType)
  await build(argv.network, argv.subgraphType)
  if (argv.deploy) {
    await deploy(argv.subgraphType)
  }
}

main()
