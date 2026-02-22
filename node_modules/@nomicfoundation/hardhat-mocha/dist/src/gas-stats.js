import { markTestWorkerDone } from "hardhat/internal/gas-analytics";
export const mochaHooks = {
    async afterAll() {
        await markTestWorkerDone("mocha");
    },
};
//# sourceMappingURL=gas-stats.js.map