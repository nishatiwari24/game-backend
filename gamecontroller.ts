import gamefunction, { GameFunction } from '../helpers/gamefunction';
import responseConstants, { PREFERRED_LANGUAGE } from '../response/constants';
import responseDispatcher from '../util/responsedispatcher';
import spinLogger from '../util/spin-logger';
import ClientRequest, { BodyParams } from '../interface/client-request';
import goldCoinCompute from '../util/games/goldcoin';
import {
  SpinResponse,
  UserSessionAndSessionRequest,
  UserSession,
  SessionObject,
} from '../interface/game';
import * as _ from 'lodash';
import gameSession from '../util/gamesession';
import { ServerResponse } from 'http';
import {
  AllPickStatus,
  GambleTypes,
  GameActionTypes,
  POP_GAMEIDS,
  SpinStates,
} from '../config/constants';
import { GoldCoinGameObject, TakeWinResponse, GambleResponse } from '../interface/games/goldcoin';
import { getObject } from '../helpers/couchbase';
import historyLogger from '../util/history-logger';
import logger from '../util/logger';
import gamesession from '../util/gamesession';

/**
 * Handles game events for goldCoin
 * @extends gameFunction.GameFunction
 */
class GoldCoin extends GameFunction {
  async spin(req: ClientRequest, res: ServerResponse) {
    try {
      const result = await this.handleSpin(req.body as BodyParams);
      if (!result || result.error) {
        const errBody = !result
          ? {
              error: PREFERRED_LANGUAGE['en'].SPIN_FAILED,
              errorCode: responseConstants.RES_ERROR_CODES.SPIN_FAILED,
            }
          : result;
        return responseDispatcher.dispatchError(res, errBody, req.body.requestTime, req);
      }
      if (!result.isSessionUpdated) {
        gameSession.gameSpin(req.body.gameId, req.body.playerId, result);
      }
      const spinResponse = _.cloneDeep(result);
      delete spinResponse.session;
      delete spinResponse.isSessionUpdated;
      const logResult = JSON.parse(JSON.stringify(spinResponse));
      spinLogger.logSpinResult(logResult, req.body.gameId, req.body.playerId);
      return responseDispatcher.dispatch(res, spinResponse, req.body.requestTime, req);
    } catch (error) {
      logger.error('Err in gold-coin spin', error);
      responseDispatcher.dispatchError(
        res,
        {
          error: PREFERRED_LANGUAGE['en'].SPIN_FAILED,
          errorCode: responseConstants.RES_ERROR_CODES.SPIN_FAILED,
        },
        req.body.requestTime,
        req,
      );
    }
  }

  /**
   * It manages session & handles spin for computing win & generating spin response
   * @param gameId Base game-id to handle spin for
   * @param token unique token of user
   * @param clientID unique ClientID of user
   * @returns SpinResponse Type for successfull spin
   */
  async handleSpin(req: BodyParams): Promise<SpinResponse> {
    try {
      const { gameId, playerId, clientId, baseGameId, secureToken } = req;
      const userSessionAndSessionRequest: UserSessionAndSessionRequest =
        await this.getUserSessionAndSessionRequest(playerId, gameId, baseGameId);
      const userSession: UserSession = userSessionAndSessionRequest[`${playerId}::${gameId}`];
      const gameConfigObj = this.getGame(gameId);
      if (!gameConfigObj) {
        return {
          error: PREFERRED_LANGUAGE[userSession?.value.language || 'en'].GAME_NOT_FOUND,
          errorCode: responseConstants.RES_ERROR_CODES.GAME_NOT_FOUND,
        };
      }
      const playerInfo = await getObject(`${req.playerId}::${POP_GAMEIDS[req.baseGameId]}`);
      if (!userSessionAndSessionRequest || !playerInfo) {
        return {
          error:
            PREFERRED_LANGUAGE[userSession?.value.language || 'en'].SPIN_NOT_ALLOWED_NO_GAME_CLICK,
          errorCode: responseConstants.RES_ERROR_CODES.SPIN_NOT_ALLOWED_NO_GAME_CLICK,
        };
      }
      const currentLines = userSession?.value.eventData.currentLines;
      const currentBet = req.totalBet / currentLines;
      // if there's some pending gamble or win to take
      if (userSession) {
        if (userSession.value.secureToken !== secureToken) {
          return {
            error: PREFERRED_LANGUAGE[userSession?.value.language].INVALID_SECURE_TOKEN,
            errorCode: responseConstants.RES_ERROR_CODES.INVALID_SECURE_TOKEN,
          };
        }
        await goldCoinCompute.validateSpinBet(
          currentBet,
          playerInfo.value,
          userSession?.value.language,
        );
        const spinState = userSession?.value.spinState;
        if (spinState && spinState !== SpinStates.DONE) {
          return {
            error: PREFERRED_LANGUAGE[userSession?.value.language].SPIN_NOT_ALLOWED,
            errorCode: responseConstants.RES_ERROR_CODES.SPIN_NOT_ALLOWED,
          };
        }
        const reSpinData = userSession?.value.eventData.reSpin;
        const sessionCurrBet = userSession?.value.eventData.currentBet;
        if (!_.isEmpty(reSpinData) && currentBet !== sessionCurrBet) {
          return {
            error:
              PREFERRED_LANGUAGE[userSession?.value.language].BET_ALTER_DENIED_FREE_SPIN_ACTIVE,
            errorCode: responseConstants.RES_ERROR_CODES.BET_ALTER_DENIED_FREE_SPIN_ACTIVE,
          };
        }
      }
      if (
        userSessionAndSessionRequest.sessionRequestKey &&
        userSessionAndSessionRequest.sessionKey
      ) {
        const sessionRequest =
          userSessionAndSessionRequest[userSessionAndSessionRequest.sessionRequestKey].value;
        if (sessionRequest.status == 'init' || sessionRequest.status == 'ready') {
          // set request current bet
          userSession.value.eventData.currentBet = currentBet;
          // allow spin
          if (userSession.value.clientID === clientId) {
            // update session request doc
            await this.updateSessionRequestDoc(
              userSessionAndSessionRequest.sessionRequestKey,
              sessionRequest,
              userSessionAndSessionRequest[userSessionAndSessionRequest.sessionRequestKey].cas,
            );

            // generate viewzone & compute wins for viewzone
            const computeData: any = await goldCoinCompute.compute(
              gameConfigObj.game as { default: GoldCoinGameObject },
              userSession.value,
            );
            return await goldCoinCompute.generateSpinResponse(
              req,
              gameConfigObj,
              computeData,
              userSessionAndSessionRequest.sessionRequestKey,
              sessionRequest,
              userSession.value,
              req.totalBet,
            );
          } else {
            // duplicate client id used
            return {
              error: PREFERRED_LANGUAGE[userSession?.value.language].INVALID_CLIENT,
              errorCode: responseConstants.RES_ERROR_CODES.INVALID_CLIENT,
            };
          }
        }
      } else {
        return {
          error: PREFERRED_LANGUAGE[userSession?.value.language].SPIN_NOT_ALLOWED,
          errorCode: responseConstants.RES_ERROR_CODES.SPIN_NOT_ALLOWED,
        };
      }
    } catch (error) {
      logger.error('Err in handle spin', error);
      return _.isString(error.message) ? JSON.parse(error.message) : error.message;
    }
  }

  /**
   * Take win when gamble mode is on
   * @param req request parameters
   * @param res success response on take succes, otherwise error response
   * @returns
   */
  async takeWin(req: ClientRequest, res: ServerResponse) {
    try {
      let session: UserSession = await gameSession.getUserSessionWithCas(
        req.body.playerId,
        req.body.gameId,
      );
      if (!session) {
        return responseDispatcher.dispatchError(
          res,
          {
            error: PREFERRED_LANGUAGE['en'].TAKE_WIN_NOT_ALLOWED_NO_GAME_CLICK,
            errorCode: responseConstants.RES_ERROR_CODES.TAKE_WIN_NOT_ALLOWED_NO_GAME_CLICK,
          },
          req.body.requestTime,
          req,
        );
      }
      // verify secure token
      if (session.value.secureToken !== req.body.secureToken) {
        return responseDispatcher.dispatchError(
          res,
          {
            error: PREFERRED_LANGUAGE[session?.value.language].INVALID_SECURE_TOKEN,
            errorCode: responseConstants.RES_ERROR_CODES.INVALID_SECURE_TOKEN,
          },
          req.body.requestTime,
          req,
        );
      }
      await gamefunction.CheckDuplicateSession(req.body, session.value);
      const result: TakeWinResponse = { userDetails: {} } as TakeWinResponse;
      // win already collected. No win to collect
      if (session.value.spinState === SpinStates.DONE) {
        return responseDispatcher.dispatchError(
          res,
          {
            error: PREFERRED_LANGUAGE[session?.value.language].NO_WINS_TO_COLLECT,
            errorCode: responseConstants.RES_ERROR_CODES.NO_WINS_TO_COLLECT,
          },
          req.body.requestTime,
          req,
        );
      }
      // win is already being collected
      if (session.value.pickStatus && session.value.pickStatus === AllPickStatus.LOCKED) {
        return responseDispatcher.dispatchError(
          res,
          {
            error: PREFERRED_LANGUAGE[session?.value.language].WIN_BEING_PICKED,
            errorCode: responseConstants.RES_ERROR_CODES.WIN_BEING_PICKED,
          },
          req.body.requestTime,
          req,
        );
      }
      // collect win
      if (
        [SpinStates.TAKE_WIN, SpinStates.TAKE_OR_GAMBLE].indexOf(session.value.spinState) !== -1
      ) {
        // lock pick status
        session.value.pickStatus = 'locked';
        session = await this.updateSessionWithCas(
          session.value,
          req.body.gameId,
          session.cas,
          req.body.playerId,
        );
        const creditReq = {
          gameId: req.body.gameId,
          skinId: req.body.skinId,
          playerId: req.body.playerId,
          baseGameId: req.body.baseGameId,
          session,
          winAmount: session.value.gamble.winAmount,
          result,
        };
        if (
          !session.value.eventData.reSpin ||
          _.isEmpty(session.value.eventData.reSpin) ||
          _.get(session.value.eventData.reSpin, 'currentReSpin') === 0
        ) {
          // credit win for maingame
          await goldCoinCompute.creditWinToWallet(creditReq);
        } else if (
          session.value.eventData.reSpin.noOfReSpins -
            session.value.eventData.reSpin.currentReSpin >=
          0
        ) {
          // credit win for respin game
          await goldCoinCompute.creditBonusWinToWallet(creditReq);
        }
      }
      return responseDispatcher.dispatch(res, result, req.body.requestTime, req);
    } catch (error) {
      logger.error(' Err in take win', error);
      return responseDispatcher.dispatchError(
        res,
        _.isString(error.message) ? JSON.parse(error.message) : error.message,
        req.body.requestTime,
        req,
      );
    }
  }

  /**
   * It performs gamble for user
   * @param req api request
   * @param res
   * @returns
   */
  async gamble(req: ClientRequest, res: ServerResponse) {
    try {
      req.body = req.body as BodyParams;
      const session: UserSession = await gamesession.getUserSessionWithCas(
        req.body.playerId,
        req.body.gameId,
      );
      if (!session) {
        throw new Error(
          JSON.stringify({
            error: PREFERRED_LANGUAGE['en'].NO_USER_SESSION,
            errorCode: responseConstants.RES_ERROR_CODES.NO_USER_SESSION,
          }),
        );
      }
      await goldCoinCompute.verifyGamble(req.body, session?.value.language);
      const gameConfigObj = this.getGame(req.body.gameId);
      if (!gameConfigObj) {
        return responseDispatcher.dispatchError(
          res,
          {
            error: PREFERRED_LANGUAGE[session?.value.language].GAME_NOT_FOUND,
            errorCode: responseConstants.RES_ERROR_CODES.GAME_NOT_FOUND,
          },
          req.body.requestTime,
          req,
        );
      }

      const gambleAmount = await goldCoinCompute.verifyGambleSession(
        req.body,
        gameConfigObj.game.default as GoldCoinGameObject,
        session,
      );
      const result: GambleResponse = {
        gambleByHalf: true,
        gambleByQuarter: true,
        gambleByFull: true,
        win: false,
        state: session.value.spinState,
        winAmount: 0,
      };
      session.value.spinState = SpinStates.GAMBLE_ACTIVE;
      session.value.gamble.count += 1;
      session.value.gamble.history.push(req.body.choice);
      await gameSession.updateSessionRequestDocWithCas(
        `${req.body.playerId}::${req.body.gameId}`,
        session.value,
        session.cas,
      );
      const winningCard = await goldCoinCompute.pickACard();
      // user won in gamble
      if (req.body.choice === winningCard) {
        await goldCoinCompute.buildGambleWin(
          session,
          gameConfigObj.game.default as GoldCoinGameObject,
          result,
          gambleAmount,
        );
        result.winAmount = session.value.gamble.winAmount;
      }
      // push gamble action data in game-cycle object
      await historyLogger.pushGameActionData(req.body.playerId, session.value.gameCycleId, {
        actionTime: new Date().toISOString(),
        bet: gambleAmount,
        type: GameActionTypes.GAMBLE,
        win: result.winAmount || 0,
      });
      // user lost gamble
      if (req.body.choice !== winningCard) {
        if (
          [GambleTypes.half, GambleTypes.quarter].indexOf(GambleTypes[req.body.gambleType]) !== -1
        ) {
          session.value.gamble.winAmount -= gambleAmount;
          goldCoinCompute.buildNextPossibleGamble(
            session.value.gamble.winAmount,
            session,
            gameConfigObj.game.default as GoldCoinGameObject,
            result,
          );
        } else {
          session.value.spinState = SpinStates.DONE;
          delete session.value.gameCycleId;
          delete session.value.gamble;
          result.gambleByFull = false;
          result.gambleByHalf = false;
          result.gambleByQuarter = false;
        }
      }
      result.state = session.value.spinState;
      await gameSession.updateSession(session.value, req.body.gameId, req.body.playerId);
      return responseDispatcher.dispatch(res, result, req.body.requestTime, req);
    } catch (error) {
      logger.error('Err in gamble', error);
      return responseDispatcher.dispatchError(
        res,
        _.isString(error.message) ? JSON.parse(error.message) : error.message,
        req.body.requestTime,
        req,
      );
    }
  }
}

export default new GoldCoin();
