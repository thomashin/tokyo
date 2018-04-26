import moment from "moment";
import get from "lodash/get";
import range from "lodash/range";
import schema from "tokyo-schema";

import ether from "./helpers/ether";
import { advanceBlock, advanceManyBlock } from "./helpers/advanceToBlock";
import increaseTime, { increaseTimeTo, duration } from "./helpers/increaseTime";
import latestTime from "./helpers/latestTime";
import EVMThrow from "./helpers/EVMThrow";
import { capture, restore, Snapshot } from "./helpers/snapshot";
import timer from "./helpers/timer";
import sendTransaction from "./helpers/sendTransaction";
import "./helpers/upgradeBigNumber";

const BigNumber = web3.BigNumber;
const eth = web3.eth;

const should = require("chai")
  .use(require("chai-as-promised"))
  .use(require("chai-bignumber")(BigNumber))
  .should();

const KYC = artifacts.require("./KYC.sol");
const Vault = artifacts.require("./MultiHolderVault.sol");
const Locker = artifacts.require("./Locker.sol");
const Token = artifacts.require("./AuditFullFeaturesToken.sol");
const Crowdsale = artifacts.require("./AuditFullFeaturesCrowdsale.sol");
const MintableToken = artifacts.require("./MintableToken.sol");

contract("AuditFullFeaturesCrowdsale", async ([ owner, other, investor1, investor2, investor3, ...accounts ]) => {
  // contract instances
  let kyc, vault, locker, token, crowdsale, otherToken;

  // TX parameteres
  const gas = 2000000;

  // test parameteres
  const input = schema.validate(getInput()).value;
  const etherAmount = getEtherAmount(input);
  const periodMaxPurchaseLimits = input.sale.stages.map(s => new BigNumber(s.max_purchase_limit));

  const minEtherAmount = new BigNumber(input.sale.valid_purchase.min_purchase_limit);
  // a purchaser can fund
  const maxEtherAmount = new BigNumber(input.sale.valid_purchase.max_purchase_limit);

  const baseRate = new BigNumber(input.sale.rate.base_rate);
  const e = ether(1);

  const coeff = new BigNumber(input.sale.coeff);
  const maxCap = new BigNumber(input.sale.max_cap);
  const minCap = new BigNumber(input.sale.min_cap);

  // erc20 token amount
  const otherTokenAmount = new BigNumber(200);
  const otherTokenSentAmount = new BigNumber(100);

  console.log(JSON.stringify(input, null, 2));

  before(async () => {
    // load contracts
    kyc = await KYC.deployed();
    vault = await Vault.deployed();
    locker = await Locker.deployed();
    token = await Token.deployed();
    crowdsale = await Crowdsale.deployed();
    otherToken = await MintableToken.new();

    console.log(`
      kyc: ${ kyc.address }
      vault: ${ vault.address }
      locker: ${ locker.address }
      token: ${ token.address }
      crowdsale: ${ crowdsale.address }
      otherToken: ${ otherToken.address }
    `);
  });

  // const snapshot = new Snapshot();
  // before(snapshot.captureContracts);
  // after(snapshot.restoreContracts);

  // helper functions
  const advanceBlocks = () => advanceManyBlock(input.sale.valid_purchase.block_interval);

  it("setup contracts", async () => {
    await kyc.register(investor1, { from: owner })
      .should.be.fulfilled;
    await kyc.register(investor2, { from: owner })
      .should.be.fulfilled;

    await advanceBlocks();
  });

  it("check parameters", async () => {
    (await crowdsale.nextTokenOwner())
      .should.be.equal(input.sale.new_token_owner);

    (await crowdsale.cap())
      .should.be.bignumber.equal(maxCap);

    (await crowdsale.goal())
      .should.be.bignumber.equal(minCap);

    const numPeriods = input.sale.stages.length;
    for (let i = 0; i < numPeriods; i++) {
      /* eslint-disable */
      const {
        start_time,
        end_time,
        cap_ratio = 0,
        max_purchase_limit = 0,
        min_purchase_limit = 0,
        kyc = false,
      } = input.sale.stages[ i ];
      /* eslint-enable */

      const [
        pCap,
        pMaxPurchaseLimit,
        pMinPurchaseLimit,
        pWeiRaised, // stage's wei raised
        pStartTime,
        pEndTime,
        pKyc,
      ] = await crowdsale.periods(i);

      pCap.should.be.bignumber.equal(maxCap.mul(cap_ratio).div(coeff));
      pMaxPurchaseLimit.should.be.bignumber.equal(max_purchase_limit);
      pMinPurchaseLimit.should.be.bignumber.equal(min_purchase_limit);
      pWeiRaised.should.be.bignumber.equal(0);
      pStartTime.should.be.bignumber.equal(start_time);
      pEndTime.should.be.bignumber.equal(end_time);
      pKyc.should.be.equal(kyc);
    }
  });

  describe("Before start time", async () => {
    it("reject buying tokens", async () => {
      await sendTransaction({
        from: investor1, to: crowdsale.address, value: etherAmount, gas,
      }).should.be.rejectedWith(EVMThrow);
    });
  });

  describe("After start time (stage 0 started)", async () => {
    const targetTime = input.sale.start_time;
    const stageIndex = 0;
    const stageMaxPurchaseLimit = input.sale.stages[ stageIndex ].max_purchase_limit;
    const stageMinPurchaseLimit = input.sale.stages[ stageIndex ].min_purchase_limit;

    it("check conditions", async () => {
      (await kyc.registeredAddress(investor1))
        .should.be.equal(true);

      (await kyc.registeredAddress(investor2))
        .should.be.equal(true);
    });

    it(`increase time to ${ targetTime }`, async () => {
      await increaseTimeTo(targetTime)
        .should.be.fulfilled;
    });

    it("reject buying tokens under min purchase", async () => {
      const investAmount = minEtherAmount.sub(ether(0.0001));

      await sendTransaction({
        from: investor1, to: crowdsale.address, value: investAmount, gas,
      }).should.be.rejectedWith(EVMThrow);
    });

    it("reject buying tokens under stage min purchase", async () => {
      const investAmount = stageMinPurchaseLimit.mul(0.99999);

      await sendTransaction({
        from: investor1, to: crowdsale.address, value: investAmount, gas,
      }).should.be.rejectedWith(EVMThrow);
    });

    it("accept buying tokens over stage max purchase", async () => {
      const investor = investor1;
      const investAmount = stageMaxPurchaseLimit.mul(1.1);

      // 400 ether remains from 800 ether of stage 0 cap
      const purchasedAmount = stageMaxPurchaseLimit; // 400 ether
      // const rate = baseRate.mul(1.3); // 200 * 1.3
      const rate = getCurrentRate(input, purchasedAmount);

      const tokenAmount = purchasedAmount.mul(rate);
      const tokenBalance = await token.balanceOf(investor);

      await advanceBlocks();
      await sendTransaction({
        from: investor, to: crowdsale.address, value: investAmount, gas,
      }).should.be.fulfilled;

      (await token.balanceOf(investor))
        .should.be.bignumber.equal(tokenBalance.add(tokenAmount));
    });

    it("reject buying tokens for unknown account", async () => {
      const investAmount = etherAmount;

      await sendTransaction({
        from: other, to: crowdsale.address, value: investAmount, gas,
      }).should.be.rejectedWith(EVMThrow);
    });

    it("accept buying tokens for valid account and ether amount", async () => {
      const investor = investor1;
      // 360 ether remains from 800 ether of stage 0 cap
      const investAmount = ether(40);
      const rate = baseRate.mul(1.2); // 200 * 1.2

      const tokenAmount = investAmount.mul(rate);
      const tokenBalance = await token.balanceOf(investor);

      await advanceBlocks();
      await sendTransaction({
        from: investor, to: crowdsale.address, value: investAmount, gas,
      }).should.be.fulfilled;

      (await token.balanceOf(investor))
        .should.be.bignumber.equal(tokenBalance.add(tokenAmount));
    });

    it("reject buying tokens within a few blocks", async () => {
      const investor = investor1;
      const investAmount = ether(10);

      await sendTransaction({
        from: investor, to: crowdsale.address, value: investAmount, gas,
      }).should.be.rejectedWith(EVMThrow);
    });

    it("accept buying tokens over stage max cap", async () => {
      const investor = investor1;
      const investAmount = ether(400);
      const purchasedAmount = ether(360); // 800 - 40 - 400

      const rate = baseRate.mul(1.3);

      const tokenAmount = purchasedAmount.mul(rate);
      const tokenBalance = await token.balanceOf(investor);

      await advanceBlocks();
      await sendTransaction({
        from: investor, to: crowdsale.address, value: investAmount, gas,
      }).should.be.fulfilled;

      (await token.balanceOf(investor))
        .should.be.bignumber.equal(tokenBalance.add(tokenAmount));
    });
  });

  describe("After stage 0 finished (stage 1 not started yet)", async () => {
    const targetTime = (input.sale.stages[ 0 ].end_time + input.sale.stages[ 1 ].start_time) / 2;

    it(`increase time to ${ targetTime }`, async () => {
      await increaseTimeTo(targetTime)
        .should.be.fulfilled;
    });

    it("reject buying tokens when stage is not on sale", async () => {
      const investor = investor2;

      // 0.01 ether, 0.1 ether, .. 1000 ether
      const investAmounts = range(6).map(i => ether(0.001).mul(10 ** i));

      await advanceBlocks();
      for (const investAmount of investAmounts) {
        await sendTransaction({
          from: investor, to: crowdsale.address, value: investAmount, gas,
        }).should.be.rejectedWith(EVMThrow);
      }
    });
  });

  describe("After stage 1 started (with time bonus 1)", async () => {
    const stageIndex = 1;
    const targetTime = input.sale.stages[ stageIndex ].start_time;
    const stageMaxPurchaseLimit = input.sale.stages[ stageIndex ].max_purchase_limit;
    const stageMinPurchaseLimit = input.sale.stages[ stageIndex ].min_purchase_limit;

    it(`increase time to ${ targetTime }`, async () => {
      await increaseTimeTo(targetTime)
        .should.be.fulfilled;
    });

    it("reject buying tokens under min purchase", async () => {
      const investAmount = ether(0.0000001);

      await sendTransaction({
        from: investor1, to: crowdsale.address, value: investAmount, gas,
      }).should.be.rejectedWith(EVMThrow);
    });

    it("reject buying tokens for unknown account", async () => {
      const investAmount = ether(10);

      await sendTransaction({
        from: other, to: crowdsale.address, value: investAmount, gas,
      }).should.be.rejectedWith(EVMThrow);
    });

    it("reject buying tokens under stage min purchase", async () => {
      const investAmount = stageMinPurchaseLimit.mul(0.99999);

      await sendTransaction({
        from: investor1, to: crowdsale.address, value: investAmount, gas,
      }).should.be.rejectedWith(EVMThrow);
    });

    it("accept buying tokens for valid account and ether amount", async () => {
      // investor 1 funed 800 ether for stage 0
      const investor = investor1;
      const investAmount = ether(20);
      const rate = getCurrentRate(input, investAmount); // 200 * 1.15

      const tokenAmount = investAmount.mul(rate);
      const tokenBalance = await token.balanceOf(investor);

      await advanceBlocks();
      await sendTransaction({
        from: investor, to: crowdsale.address, value: investAmount, gas,
      }).should.be.fulfilled;

      (await token.balanceOf(investor))
        .should.be.bignumber.equal(tokenBalance.add(tokenAmount));
    });

    it("reject buying tokens within a few blocks", async () => {
      const investor = investor1;
      const investAmount = ether(10);

      await sendTransaction({
        from: investor, to: crowdsale.address, value: investAmount, gas,
      }).should.be.rejectedWith(EVMThrow);
    });

    it("accept buying tokens over personal max purchase limit", async () => {
      const investor = investor1;
      const investAmount = ether(2500);

      // investor 1 funded 820 ether previously. so now he can fund at most 1180 ether.
      const purchasedAmount = ether(1180);

      const rate = getCurrentRate(input, purchasedAmount); // 200 * 1.15

      const tokenAmount = purchasedAmount.mul(rate);
      const tokenBalance = await token.balanceOf(investor);

      await advanceBlocks();
      await sendTransaction({
        from: investor, to: crowdsale.address, value: investAmount, gas,
      }).should.be.fulfilled;

      (await token.balanceOf(investor))
        .should.be.bignumber.equal(tokenBalance.add(tokenAmount));
    });
  });

  describe("After time bonus 1 finished (stage 1 not finished)", async () => {
    const targetTime = input.sale.rate.bonus.time_bonuses[ 1 ].bonus_time_stage;

    it(`increase time to ${ targetTime }`, async () => {
      await increaseTimeTo(targetTime)
        .should.be.fulfilled;
    });

    it("reject buying tokens under min purchase", async () => {
      const investAmount = ether(0.0000001);

      await sendTransaction({
        from: investor2, to: crowdsale.address, value: investAmount, gas,
      }).should.be.rejectedWith(EVMThrow);
    });

    it("reject buying tokens for unknown account", async () => {
      const investAmount = ether(10);

      await sendTransaction({
        from: other, to: crowdsale.address, value: investAmount, gas,
      }).should.be.rejectedWith(EVMThrow);
    });

    it("accept buying tokens for valid account and ether amount", async () => {
      const investor = investor2;
      const investAmount = ether(20);
      // 2020 ether funded for the sale
      const rate = getCurrentRate(input, investAmount); // 200 * 1.15

      const tokenAmount = investAmount.mul(rate);
      const tokenBalance = await token.balanceOf(investor);

      await advanceBlocks();
      await sendTransaction({
        from: investor, to: crowdsale.address, value: investAmount, gas,
      }).should.be.fulfilled;

      (await token.balanceOf(investor))
        .should.be.bignumber.equal(tokenBalance.add(tokenAmount));
    });

    it("reject buying tokens within a few blocks", async () => {
      const investor = investor2;
      const investAmount = ether(10);

      await sendTransaction({
        from: investor, to: crowdsale.address, value: investAmount, gas,
      }).should.be.rejectedWith(EVMThrow);
    });

    it("accept buying tokens over personal max purchase limit", async () => {
      const investor = investor2;
      const investAmount = ether(2000);

      // investor 2 funded 20 ether previously. so now he can fund at most 1980 ether.
      const purchasedAmount = ether(1980);

      const rate = getCurrentRate(input, purchasedAmount); // 200 * 1.25

      const tokenAmount = purchasedAmount.mul(rate);
      const tokenBalance = await token.balanceOf(investor);

      await advanceBlocks();
      await sendTransaction({
        from: investor, to: crowdsale.address, value: investAmount, gas,
      }).should.be.fulfilled;

      (await token.balanceOf(investor))
        .should.be.bignumber.equal(tokenBalance.add(tokenAmount));

      (await crowdsale.weiRaised())
        .should.be.bignumber.equal(ether(4000)); // max cap reached
    });
  });

  describe("mistakenly send ERC20 tokens", async () => {
    before(async () => {
      await otherToken.mint(investor3, otherTokenAmount)
        .should.be.fulfilled;
    });

    it("should erc20 sent to crowdsale address", async () => {
      const investor = investor3;

      const tokenAmountBeforeTransfer = await otherToken.balanceOf(investor);
      await otherToken.transfer(crowdsale.address, otherTokenSentAmount, { from: investor })
        .should.be.fulfilled;
      const tokenAmountAfterTransfer = await otherToken.balanceOf(investor);

      tokenAmountAfterTransfer.should.be.bignumber
        .equal(tokenAmountBeforeTransfer.sub(otherTokenSentAmount));

      const crowdsaleTokenAmount = await otherToken.balanceOf(crowdsale.address);
      const crowdsaleOwnerTokenAmount = await otherToken.balanceOf(owner);

      crowdsaleTokenAmount.should.be.bignumber
        .equal(otherTokenSentAmount);
      crowdsaleOwnerTokenAmount.should.be.bignumber
        .equal(0);
    });

    it("should not claimed before crowdsale finish", async () => {
      await crowdsale.claimTokens(otherToken.address)
        .should.be.rejectedWith(EVMThrow);
    });
  });

  describe("After stage 1 finished", async () => {
    const targetTime = input.sale.stages[ 1 ].end_time + 10;

    it(`increase time to ${ targetTime }`, async () => {
      await increaseTimeTo(targetTime)
        .should.be.fulfilled;
    });

    it("should finalize crowdsale and distribute token correctly", async () => {
      const tokenDistributions = input.sale.distribution.token;
      const lockerRatio = tokenDistributions
        .filter(t => t.token_holder === "locker")[ 0 ].token_ratio;
      const saleRatio = tokenDistributions
        .filter(t => t.token_holder === "crowdsale")[ 0 ].token_ratio;

      const saleAmounts = await token.totalSupply();

      await crowdsale.finalize()
        .should.be.fulfilled;

      const totalSupply = await token.totalSupply();

      const lockerAmounts = await token.balanceOf(locker.address);

      lockerAmounts.should.be.bignumber.equal(totalSupply.mul(lockerRatio).div(coeff));
      saleAmounts.should.be.bignumber.equal(totalSupply.mul(saleRatio).div(coeff));

      /* eslint-disable camelcase */
      for (const { token_holder, token_ratio } of tokenDistributions) {
        if (![ "crowdsale", "locker" ].includes(token_holder)) {
          const tokenAmounts = await token.balanceOf(token_holder);
          tokenAmounts.should.be.bignumber
            .equal(totalSupply.mul(token_ratio).div(coeff));
        }
      }
      /* eslint-enable camelcase */
    });
  });

  describe("claim ERC20 Tokens", async () => {
    it("should claimed", async () => {
      const crowdsaleOtherTokenBalanceBeforeClaim = await otherToken.balanceOf(crowdsale.address);
      await crowdsale.claimTokens(otherToken.address)
        .should.be.fulfilled;
      const crowdsaleOtherTokenBalanceAfterClaim = await otherToken.balanceOf(crowdsale.address);

      crowdsaleOtherTokenBalanceAfterClaim.should.be.bignumber
        .equal(crowdsaleOtherTokenBalanceBeforeClaim.sub(otherTokenSentAmount));

      const crowdsaleOwnerOtherTokenAmount = await otherToken.balanceOf(owner);
      crowdsaleOwnerOtherTokenAmount.should.be.bignumber
        .equal(otherTokenSentAmount);
    });
  });
});

function getInput() {
  return JSON.parse('{"project_name":"Audit Full Features","token":{"token_type":{"is_minime":true},"token_option":{"burnable":true,"pausable":true},"token_name":"For Audit","token_symbol":"FA","decimals":18},"sale":{"max_cap":"4000000000000000000000","min_cap":"1000000000000000000000","start_time":"2018/05/23 00:00:00","end_time":"2018/05/27 00:00:00","coeff":"1000","rate":{"is_static":false,"base_rate":"200","bonus":{"use_time_bonus":true,"use_amount_bonus":true,"time_bonuses":[{"bonus_time_stage":"2018/05/24 00:00:00","bonus_time_ratio":"100"},{"bonus_time_stage":"2018/05/26 00:00:00","bonus_time_ratio":"50"}],"amount_bonuses":[{"bonus_amount_stage":"100000000000000000000","bonus_amount_ratio":"200"},{"bonus_amount_stage":"10000000000000000000","bonus_amount_ratio":"100"},{"bonus_amount_stage":"1000000000000000000","bonus_amount_ratio":"50"}]}},"distribution":{"token":[{"token_holder":"crowdsale","token_ratio":"800"},{"token_holder":"locker","token_ratio":"100"},{"token_holder":"0x557678cf28594495ef4b08a6447726f931f8d787","token_ratio":"100"}],"ether":[{"ether_holder":"0x557678cf28594495ef4b08a6447726f931f8d787","ether_ratio":"800"},{"ether_holder":"0x557678cf28594495ef4b08a6447726f931f8d788","ether_ratio":"200"}]},"stages":[{"start_time":"2018/05/23 00:00:00","end_time":"2018/05/24 00:00:00","cap_ratio":"200","max_purchase_limit":"400000000000000000000","min_purchase_limit":"100000000000000","kyc":true},{"start_time":"2018/05/25 00:00:00","end_time":"2018/05/27 00:00:00","cap_ratio":"0","max_purchase_limit":"0","min_purchase_limit":"0","kyc":true}],"valid_purchase":{"max_purchase_limit":"2000000000000000000000","min_purchase_limit":"10000000000000000","block_interval":20},"new_token_owner":"0x557678cf28594495ef4b08a6447726f931f8d787"},"multisig":{"use_multisig":true,"infos":[{"num_required":1,"owners":["0x557678cf28594495ef4b08a6447726f931f8d787","0x557678cf28594495ef4b08a6447726f931f8d788"]},{"num_required":1,"owners":["0x557678cf28594495ef4b08a6447726f931f8d789","0x557678cf28594495ef4b08a6447726f931f8d78a"]}]},"locker":{"use_locker":true,"beneficiaries":[{"address":"0x557678cf28594495ef4b08a6447726f931f8d787","ratio":"200","is_straight":true,"release":[{"release_time":"2018/05/28 00:00:00","release_ratio":"300"},{"release_time":"2018/05/30 00:00:00","release_ratio":"1000"}]},{"address":"0x557678cf28594495ef4b08a6447726f931f8d788","ratio":"800","is_straight":false,"release":[{"release_time":"2018/05/27 00:00:00","release_ratio":"200"},{"release_time":"2018/05/28 00:00:00","release_ratio":"500"},{"release_time":"2018/05/30 00:00:00","release_ratio":"1000"}]}]}}');
}

/* eslint-disable complexity,camelcase */
function getCurrentRate(input, amount) {
  const now = latestTime().unix();
  const {
    sale: {
      coeff,
      rate: {
        base_rate,
        bonus: {
          use_time_bonus = false,
          use_amount_bonus = false,
          time_bonuses = [],
          amount_bonuses = [],
        },
      },
    },
  } = input;

  let timeBonus = 0,
    amountBonus = 0;

  if (use_time_bonus) {
    for (const { bonus_time_stage, bonus_time_ratio } of time_bonuses) {
      if (now <= bonus_time_stage) {
        timeBonus = bonus_time_ratio;
        break;
      }
    }
  }

  if (use_amount_bonus) {
    for (const { bonus_amount_stage, bonus_amount_ratio } of amount_bonuses) {
      if (amount.gte(bonus_amount_stage)) {
        amountBonus = bonus_amount_ratio;
        break;
      }
    }
  }

  const totalBonus = new BigNumber(timeBonus).add(new BigNumber(amountBonus));
  const rate = totalBonus.add(coeff).mul(base_rate).div(coeff);

  return rate;
}
/* eslint-enable complexity,camelcase */

function getEtherAmount(input) {
  if (input.sale.valid_purchase.min_purchase_limit) {
    return new BigNumber(input.sale.valid_purchase.min_purchase_limit).add(ether(0.1));
  }
  return ether(1);
}
