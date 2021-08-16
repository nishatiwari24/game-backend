import * as finalhandler from 'finalhandler';
import * as http from 'http';
import * as Router from 'router';
import constants from './response/constants';
import * as compression from 'compression';
import * as cors from 'cors';
import gamefunction from './helpers/gamefunction';
import responseDispatcher from './util/responsedispatcher';
import game from './routes/game';
import { json, urlencoded } from 'express';
import gameValidator from './validator/game';
import config from './config';
import maintenance from './util/maintenance';
import pop from './routes/pop';
import marketPlaceValidator from './validator/marketplace';
import marketPlaceController from './controller/marketplace';
import support from './routes/support';
import logger from './util/logger';
import monitor from './controller/monitor';
import messageValidator from './validator/message';

const router = Router({});

/**
 *enables cross origin request
 */
router.use(cors());
/**
 * compress responses
 */
router.use(compression());

/**
 * Use body parser to parse request body
 */
router.use(json());
router.use(urlencoded({ extended: false }));

/**
 * registered route for game apis
 */
router.get('/game*', maintenance.checkStatus, gameValidator.validateGameId, game);
router.post('/game*', maintenance.checkStatus, gameValidator.validateGameId, game);

/**
 * Routes for POP APIs
 */
router.post('/pop*', pop);
router.get('/pop*', pop);

/**
 * Routes for Support APIs
 */
router.post('/support*', support);

/**
 * Routes for market place APIs
 */
router.post(
  '/tpi',
  marketPlaceValidator.validateGameListRequest,
  marketPlaceController.getGameList,
);

router.post('/message', messageValidator.validateMessageRequest);

router.use('/health', monitor.healthCheck);

router.use('/ping', (req, res) => {
  responseDispatcher.dispatchPing(res);
});

/**
 * It returns user-game session statistics/counts
 */
router.get('/session-stats', monitor.getSessionStats);

process.on('uncaughtException', (err) => {
  logger.error('uncaughtException : ', err);
});

/**
 * global exception handler
 * does maintainance task
 */
router.use((req, res) => {
  responseDispatcher.dispatch404(res);
});

/**
 * Create Http server
 */
const server = http.createServer((req, res) => {
  /**
   * attach final handler to route Object in order to route every request
   */
  router(req, res, finalhandler(req, res));
});

/**
 * Server listens on given httpPort
 */
server.listen(config.application.httpPort);
logger.debug(`server started on port number: ${config.application.httpPort}`);
gamefunction.gameLookupLoop();
