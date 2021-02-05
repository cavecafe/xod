import * as R from 'ramda';
import {
  renameKeys,
  invertMap,
  foldMaybe,
  maybePath,
  isAmong,
} from 'xod-func-tools';

import { ERROR_CODES } from 'xod-cloud-compile';

import {
  UPLOAD,
  INSTALL_ARDUINO_DEPENDENCIES,
  CHECK_ARDUINO_DEPENDENCIES,
  UPGRADE_ARDUINO_DEPENDECIES,
  DEBUGGER_LOG_ADD_MESSAGES,
  DEBUGGER_LOG_CLEAR,
  DEBUGGER_LOG_START_SKIPPING_NEW_LINES,
  DEBUGGER_LOG_STOP_SKIPPING_NEW_LINES,
  DEBUGGER_LOG_TOGGLE_XOD_PROTOCOL_MESSAGES,
  DEBUG_SESSION_STARTED,
  SERIAL_SESSION_STARTED,
  DEBUG_SESSION_STOPPED,
  MARK_DEBUG_SESSION_OUTDATED,
  SELECT_DEBUGGER_TAB,
  LINE_SENT_TO_SERIAL,
  TETHERING_INET_CREATED,
  TETHERING_INET_CHUNKS_ADDED,
  TETHERING_INET_CHUNK_SENT,
  TETHERING_INET_CLEAR_CHUNKS,
} from './actionTypes';

import * as EAT from '../editor/actionTypes';

import { UPLOAD_MSG_TYPE, LOG_TAB_TYPE, SESSION_TYPE, NEW_SHEET } from './constants';
import * as MSG from './messages';
import { STATUS } from '../utils/constants';
import { isXodErrorMessage } from './debugProtocol';

import {
  createSystemMessage,
  createFlasherMessage,
  createErrorMessage,
  createOutgoingLogMessage,
  isErrorMessage,
} from './utils';

import { default as initialState, DEFAULT_TETHERING_INET_STATE } from './state';

const MAX_LOG_CHARACTERS = 10000;

// =============================================================================
//
// Utils
//
// =============================================================================

const formatMessage = msg => {
  switch (msg.type) {
    case UPLOAD_MSG_TYPE.SYSTEM:
      return `=== ${msg.message} ===`;

    case UPLOAD_MSG_TYPE.ERROR: {
      const stack = msg.stack ? `\n${msg.stack}` : '';
      return `${msg.message}${stack}`;
    }

    case UPLOAD_MSG_TYPE.LOG:
      return `↘ ${msg.message}`;

    case UPLOAD_MSG_TYPE.XOD:
      return `↘ ${msg.prefix} ${msg.timecode} ${msg.nodeId} ${msg.content}`;

    case UPLOAD_MSG_TYPE.LOG_OUTGOING:
      return `↖ ${msg.message}`;

    default:
      return msg.message;
  }
};

const overTabLog = tabType => R.over(R.lensPath([tabType, 'log']));
const overInstallerLog = overTabLog(LOG_TAB_TYPE.INSTALLER);
const overCompilerLog = overTabLog(LOG_TAB_TYPE.COMPILER);
const overUploaderLog = overTabLog(LOG_TAB_TYPE.UPLOADER);
const overDebuggerLog = overTabLog(LOG_TAB_TYPE.DEBUGGER);
const overTesterLog = overTabLog(LOG_TAB_TYPE.TESTER);

const overStageError = stage => R.over(R.lensPath([stage, 'error']));

const appendMessage = R.curry((msg, log) => {
  const formattedMessage = formatMessage(msg);
  return log === '' ? formattedMessage : `${log}\n${formatMessage(msg)}`;
});

const appendMessageAndTruncate = R.curry((msg, prevLog) =>
  R.compose(
    R.when(
      log => log.length > MAX_LOG_CHARACTERS,
      R.compose(
        log => `=== Older lines are truncated ===\n${log}`,
        log => log.slice(log.indexOf('\n') + 1),
        log => log.slice(-MAX_LOG_CHARACTERS)
      )
    ),
    appendMessage(msg)
  )(prevLog)
);

const addMessageToDebuggerLog = R.curry((message, state) =>
  overDebuggerLog(appendMessageAndTruncate(message), state)
);

const addPlainTextToDebuggerLog = R.curry((plainMessage, state) =>
  overDebuggerLog(log => `${log}\n${plainMessage}`, state)
);

const addPlainTextToTesterLog = R.curry((plainMessage, state) =>
  overTesterLog(log => `${log}\n${plainMessage}`, state)
);

const addMessageListToDebuggerLog = R.curry((messages, state) =>
  overDebuggerLog(
    R.reduce(R.flip(appendMessageAndTruncate), R.__, messages),
    state
  )
);

const addMessagesOrIncrementSkippedLines = R.curry(
  (logMessages, state) =>
    state.isSkippingNewSerialLogLines
      ? R.over(
          R.lensProp('numberOfSkippedSerialLogLines'),
          R.add(R.length(logMessages)),
          state
        )
      : addMessageListToDebuggerLog(logMessages, state)
);

const updateInteractiveNodeValues = R.curry((messageList, state) => {
  const MapToRekey = R.prop('nodeIdsMap', state);
  // All node ids that is not represented in `tableLogNodeIds` is `watch` nodes
  const [tableLogMessages, watchNodeMessages] = R.compose(
    R.map(R.fromPairs),
    R.partition(R.compose(isAmong(state.tableLogNodeIds), R.nth(0))),
    R.toPairs,
    renameKeys(MapToRekey),
    R.groupBy(R.prop('nodeId')),
    R.filter(R.propEq('type', UPLOAD_MSG_TYPE.XOD))
  )(messageList);

  const updateWatchNodeValues = R.compose(
    newValues =>
      R.over(R.lensProp('watchNodeValues'), R.merge(R.__, newValues)),
    R.map(R.compose(R.prop('content'), R.last))
  )(watchNodeMessages);

  // Prepare data for table logs
  const newTableLogData = R.map(
    R.compose(
      R.reduce(
        (acc, val) =>
          val === NEW_SHEET
            ? R.append([], acc)
            : R.over(
                R.lensIndex(acc.length - 1),
                R.append(R.split('\t', val)),
                acc
              ),
        [[]]
      ),
      R.pluck('content')
    )
  )(tableLogMessages);

  const updateTableLogs = R.compose(
    R.map(([nodeId, [dataToLastSheet, ...newSheets]]) =>
      R.over(
        R.lensProp(nodeId),
        R.compose(
          R.concat(R.__, newSheets),
          sheets =>
            R.over(
              R.lensIndex(sheets.length - 1),
              R.concat(R.__, dataToLastSheet),
              sheets
            ),
          R.when(R.isEmpty, R.append([])),
          R.defaultTo([])
        )
      )
    ),
    R.toPairs
  )(newTableLogData);

  return R.compose(
    updateWatchNodeValues,
    R.over(
      R.lensProp('tableLogValues'),
      R.reduce((acc, fn) => fn(acc), R.__, updateTableLogs)
    )
  )(state);
});

/* eslint-disable no-bitwise */
const filterPinKeysByBitmask = R.curry((pinKeys, bitmask) =>
  R.addIndex(R.filter)((val, idx) => bitmask & (1 << idx), pinKeys)
);
/* eslint-enable no-bitwise */

const updateInteractiveErroredNodePins = R.curry((messageList, state) => {
  const nodeIdsMap = R.prop('nodeIdsMap', state);
  const pinKeysByNodeId = R.prop('nodePinKeysMap', state);
  return R.over(
    R.lensProp('interactiveErroredNodePins'),
    oldValues =>
      R.compose(
        R.reject(R.isEmpty),
        R.merge(oldValues),
        R.reduce((acc, val) => {
          const bitmask = parseInt(val.content, 10);
          const originalNodeId = nodeIdsMap[val.nodeId];
          const filteredPinKeys = filterPinKeysByBitmask(
            pinKeysByNodeId[originalNodeId],
            bitmask
          );
          return R.assoc(originalNodeId, filteredPinKeys, acc);
        }, {}),
        R.values,
        R.map(R.last), // the latest error message for each NodeId
        R.groupBy(R.prop('nodeId')),
        R.filter(isXodErrorMessage)
      )(messageList),
    state
  );
});

const hideProgressBar = R.assoc('uploadProgress', null);

const getMessageFromErrResponce = R.compose(
  foldMaybe('', R.concat(R.__, '\n')),
  maybePath(['payload', 'message'])
);

const getStdErrLogFromErrResponce = R.compose(
  foldMaybe(
    '',
    R.compose(
      R.join('\n'),
      R.reject(R.either(R.isNil, R.isEmpty)),
      R.pluck('stderr')
    )
  ),
  maybePath(['payload', 'logs'])
);

const getErrorTypeFromErrResponce = R.compose(
  foldMaybe('', errType => `Error type: ${errType}\n`),
  maybePath(['payload', 'data', 'type'])
);

const formatWasmError = err => {
  switch (err.type) {
    case ERROR_CODES.WASM_COMPILATION_RESULTS_FETCH_ERROR:
      return MSG.WASM_NETWORK_ERROR;
    case ERROR_CODES.WRONG_AUTHORIZATION_TOKEN:
      return MSG.WRONG_AUTHORIZATION_TOKEN;
    case ERROR_CODES.COMPILATION_LIMIT_EXCEEDED:
      return MSG.COMPILATION_LIMIT_EXCEEDED;
    case ERROR_CODES.COMPILATION_SERVICE_ERROR:
      return MSG.COMPILATION_SERVICE_OFFLINE;
    case ERROR_CODES.WASM_UNKNOWN_COMPILATION_ERROR: {
      const logs = getStdErrLogFromErrResponce(err);
      const messageWithNl = getMessageFromErrResponce(err);
      return `${messageWithNl}${logs}`;
    }
    case ERROR_CODES.WASM_COMPILATION_ERROR: {
      const logs = getStdErrLogFromErrResponce(err);
      const messageWithNl = getMessageFromErrResponce(err);
      return `${messageWithNl}${logs}\n\n${MSG.WASM_BUILDING_ERROR}`;
    }

    case ERROR_CODES.WASM_EXECUTION_ABORT:
    case ERROR_CODES.WASM_NONZERO_EXIT_CODE:
      return R.concat(
        err.payload.stdout.join('\n'),
        err.payload.stderr.join('\n')
      );
    case ERROR_CODES.WASM_NO_RUNTIME_FOUND:
      return MSG.WASM_NO_RUNTIME_FOUND;
    case ERROR_CODES.WASM_BINARY_NOT_FOUND:
      return MSG.WASM_BINARY_NOT_FOUND;

    default: {
      const message = err.message
        ? `${err.message}\n`
        : getMessageFromErrResponce(err);
      const stdErr = getStdErrLogFromErrResponce(err);
      const errType = getErrorTypeFromErrResponce(err);
      return `${message}${errType}${stdErr}`;
    }
  }
};

const rekeyAndAssocPinsAffectedByErrorRaisers = R.curry(
  (keyMap, pinsAffectedByErrorRaisers, state) =>
    R.assoc(
      'pinsAffectedByErrorRaisers',
      renameKeys(keyMap, pinsAffectedByErrorRaisers),
      state
    )
);

// =============================================================================
//
// Reducer
//
// =============================================================================

export default (state = initialState, action) => {
  switch (action.type) {
    case SELECT_DEBUGGER_TAB:
      return R.assoc('currentTab', action.payload, state);
    case INSTALL_ARDUINO_DEPENDENCIES:
    case UPGRADE_ARDUINO_DEPENDECIES:
    case CHECK_ARDUINO_DEPENDENCIES: {
      const { type, payload, meta: { status } } = action;

      const beginMsg = {
        [INSTALL_ARDUINO_DEPENDENCIES]: MSG.INSTALLING_DEPENDENCIES,
        [CHECK_ARDUINO_DEPENDENCIES]: MSG.CHECKING_DEPENDENCIES,
        [UPGRADE_ARDUINO_DEPENDECIES]: MSG.UPDATING_ARDUINO_DEPENDECIES,
      }[type];

      const successMsg = {
        [INSTALL_ARDUINO_DEPENDENCIES]: MSG.INSTALLING_DEPENDENCIES_SUCCESS,
        [CHECK_ARDUINO_DEPENDENCIES]: MSG.CHECKING_DEPENDENCIES_SUCCESS,
        [UPGRADE_ARDUINO_DEPENDECIES]: MSG.UPDATING_ARDUINO_DEPENDECIES_SUCCESS,
      }[type];

      if (status === STATUS.STARTED) {
        return R.compose(
          R.assoc('currentTab', LOG_TAB_TYPE.INSTALLER),
          R.assoc('currentStage', LOG_TAB_TYPE.INSTALLER),
          R.assoc('uploadProgress', 0),
          overInstallerLog(appendMessage(createFlasherMessage(beginMsg))),
          overInstallerLog(R.always('')),
          overCompilerLog(R.always('')),
          overUploaderLog(R.always('')),
          overDebuggerLog(R.always('')),
          overStageError(LOG_TAB_TYPE.INSTALLER)(R.always('')),
          overStageError(LOG_TAB_TYPE.COMPILER)(R.always('')),
          overStageError(LOG_TAB_TYPE.UPLOADER)(R.always('')),
          overStageError(LOG_TAB_TYPE.DEBUGGER)(R.always(''))
        )(state);
      }
      if (status === STATUS.PROGRESSED) {
        const { message, percentage } = payload;

        return R.compose(
          R.assoc('uploadProgress', percentage),
          R.when(
            () => message,
            overInstallerLog(appendMessage(createFlasherMessage(message)))
          )
        )(state);
      }
      if (status === STATUS.SUCCEEDED) {
        return R.compose(
          R.ifElse(
            () => type === CHECK_ARDUINO_DEPENDENCIES,
            // If we just checked arduino dependencies and everything OK — continue upload
            R.compose(
              R.assoc('currentTab', LOG_TAB_TYPE.COMPILER),
              R.assoc('currentStage', LOG_TAB_TYPE.COMPILER)
            ),
            // If we installed dependencies — hide progress bar
            hideProgressBar
          ),
          overInstallerLog(appendMessage(createSystemMessage(successMsg)))
        )(state);
      }
      if (status === STATUS.DELETED) {
        return hideProgressBar(state);
      }
      if (status === STATUS.FAILED) {
        return R.compose(
          hideProgressBar,
          overStageError(state.currentStage)(
            appendMessage(createErrorMessage(payload.message))
          )
        )(state);
      }

      return state;
    }
    case UPLOAD: {
      const { payload, meta: { status } } = action;

      if (status === STATUS.STARTED) {
        return R.compose(
          R.assoc('currentTab', LOG_TAB_TYPE.COMPILER),
          R.assoc('currentStage', LOG_TAB_TYPE.COMPILER),
          R.assoc('uploadProgress', 0),
          overCompilerLog(appendMessage(createFlasherMessage(MSG.TRANSPILING))),
          overCompilerLog(R.always('')),
          overUploaderLog(R.always('')),
          overDebuggerLog(R.always('')),
          overStageError(LOG_TAB_TYPE.COMPILER)(R.always('')),
          overStageError(LOG_TAB_TYPE.UPLOADER)(R.always('')),
          overStageError(LOG_TAB_TYPE.DEBUGGER)(R.always(''))
        )(state);
      }
      if (status === STATUS.PROGRESSED) {
        const { message, percentage, tab } = payload;
        return R.compose(
          R.assoc('uploadProgress', percentage),
          R.assoc('currentTab', tab),
          R.assoc('currentStage', tab),
          overTabLog(tab)(appendMessage(createFlasherMessage(message)))
        )(state);
      }
      if (status === STATUS.SUCCEEDED) {
        return R.compose(
          hideProgressBar,
          R.assoc('currentTab', LOG_TAB_TYPE.UPLOADER),
          R.assoc('currentStage', LOG_TAB_TYPE.UPLOADER),
          overUploaderLog(
            R.compose(
              appendMessage(createSystemMessage(MSG.SUCCES)),
              appendMessage(createFlasherMessage(payload.message))
            )
          )
        )(state);
      }
      if (status === STATUS.DELETED) {
        return hideProgressBar(state);
      }
      if (status === STATUS.FAILED) {
        return R.compose(
          hideProgressBar,
          overStageError(state.currentStage)(
            appendMessage(createErrorMessage(payload.message))
          )
        )(state);
      }

      return state;
    }
    case DEBUGGER_LOG_START_SKIPPING_NEW_LINES:
      return R.assoc('isSkippingNewSerialLogLines', true, state);
    case DEBUGGER_LOG_STOP_SKIPPING_NEW_LINES:
      return R.compose(
        R.assoc('isSkippingNewSerialLogLines', false),
        R.assoc('numberOfSkippedSerialLogLines', 0),
        R.when(
          ({ numberOfSkippedSerialLogLines }) =>
            action.payload.force || numberOfSkippedSerialLogLines > 0,
          addMessageToDebuggerLog(
            createSystemMessage(
              `Skipped ${state.numberOfSkippedSerialLogLines} lines`
            )
          )
        )
      )(state);
    case DEBUGGER_LOG_TOGGLE_XOD_PROTOCOL_MESSAGES:
      return R.over(
        R.lensProp('isCapturingDebuggerProtocolMessages'),
        R.not,
        state
      );
    case DEBUGGER_LOG_ADD_MESSAGES: {
      const allMessages = action.payload;

      const [errorMessages, logMessages] = R.compose(
        R.partition(isErrorMessage),
        state.isCapturingDebuggerProtocolMessages
          ? R.identity
          : R.reject(R.propEq('type', UPLOAD_MSG_TYPE.XOD))
      )(allMessages);

      const addErrorMessage = R.isEmpty(errorMessages)
        ? R.identity
        : overStageError(state.currentStage)(
            appendMessageAndTruncate(errorMessages[0])
          );

      return R.compose(
        addErrorMessage,
        addMessagesOrIncrementSkippedLines(logMessages),
        updateInteractiveErroredNodePins(allMessages),
        updateInteractiveNodeValues(allMessages)
      )(state);
    }
    case LINE_SENT_TO_SERIAL:
      return addMessagesOrIncrementSkippedLines(
        [createOutgoingLogMessage(action.payload.replace(/\r\n$/g, ''))],
        state
      );
    case DEBUGGER_LOG_CLEAR:
      return R.compose(
        // TODO: should reset skip state?
        overInstallerLog(R.always('')),
        overCompilerLog(R.always('')),
        overUploaderLog(R.always('')),
        overDebuggerLog(R.always('')),
        overTesterLog(R.always('')),
        overStageError(LOG_TAB_TYPE.INSTALLER)(R.always('')),
        overStageError(LOG_TAB_TYPE.COMPILER)(R.always('')),
        overStageError(LOG_TAB_TYPE.UPLOADER)(R.always('')),
        overStageError(LOG_TAB_TYPE.DEBUGGER)(R.always('')),
        overStageError(LOG_TAB_TYPE.TESTER)(R.always(''))
      )(state);
    case DEBUG_SESSION_STARTED: {
      const invertedNodeIdsMap = invertMap(action.payload.nodeIdsMap);
      return R.compose(
        addMessageToDebuggerLog(action.payload.message),
        overStageError(LOG_TAB_TYPE.DEBUGGER)(R.always('')),
        R.assoc('currentTab', LOG_TAB_TYPE.DEBUGGER),
        R.assoc('currentStage', LOG_TAB_TYPE.DEBUGGER),
        R.assoc('isSkippingNewSerialLogLines', false),
        R.assoc('numberOfSkippedSerialLogLines', 0),
        R.assoc('nodeIdsMap', invertedNodeIdsMap),
        R.assoc('tableLogNodeIds', action.payload.tableLogNodeIds),
        R.assoc('nodePinKeysMap', action.payload.nodePinKeysMap),
        rekeyAndAssocPinsAffectedByErrorRaisers(
          invertedNodeIdsMap,
          action.payload.pinsAffectedByErrorRaisers
        ),
        R.assoc('activeSession', SESSION_TYPE.DEBUG),
        R.assoc('isOutdated', false),
        R.assoc('globals', action.payload.globals)
      )(state);
    }
    case SERIAL_SESSION_STARTED:
      return R.compose(
        addMessageToDebuggerLog(action.payload.message),
        overDebuggerLog(R.always('')),
        overStageError(LOG_TAB_TYPE.DEBUGGER)(R.always('')),
        R.assoc('currentTab', LOG_TAB_TYPE.DEBUGGER),
        R.assoc('currentStage', LOG_TAB_TYPE.DEBUGGER),
        R.assoc('isSkippingNewSerialLogLines', false),
        R.assoc('numberOfSkippedSerialLogLines', 0),
        R.assoc('activeSession', SESSION_TYPE.SERIAL),
        R.assoc('isOutdated', false)
      )(state);
    case DEBUG_SESSION_STOPPED:
      return R.compose(
        addMessageToDebuggerLog(action.payload.message),
        R.assoc('isSkippingNewSerialLogLines', false),
        R.assoc('numberOfSkippedSerialLogLines', 0),
        R.assoc('interactiveErroredNodePins', {}),
        R.assoc('pinsAffectedByErrorRaisers', {}),
        R.assoc('watchNodeValues', {}),
        R.assoc('nodeIdsMap', {}),
        R.assoc('globals', {}),
        R.assoc('activeSession', SESSION_TYPE.NONE),
        R.assoc('tetheringInet', DEFAULT_TETHERING_INET_STATE)
      )(state);
    case MARK_DEBUG_SESSION_OUTDATED:
      return R.assoc('isOutdated', true, state);
    case TETHERING_INET_CREATED:
      return R.over(
        R.lensProp('tetheringInet'),
        R.compose(
          R.assoc('nodeId', action.payload.nodeId),
          R.assoc('sender', action.payload.sender),
          R.assoc('transmitter', action.payload.transmitter)
        ),
        state
      );
    case TETHERING_INET_CHUNKS_ADDED:
      return R.over(
        R.lensPath(['tetheringInet', 'chunksToSend']),
        R.concat(R.__, action.payload),
        state
      );
    case TETHERING_INET_CHUNK_SENT:
      return R.over(
        R.lensPath(['tetheringInet', 'chunksToSend']),
        R.tail,
        state
      );
    case TETHERING_INET_CLEAR_CHUNKS:
      return R.assocPath(['tetheringInet', 'chunksToSend'], [], state);

    case EAT.TABTEST_RUN_REQUESTED:
      return R.compose(
        overTesterLog(R.always(MSG.TABTEST_GENERATING_CODE)),
        overStageError(LOG_TAB_TYPE.TESTER)(R.always('')),
        R.assoc('uploadProgress', 25),
        R.assoc('currentTab', LOG_TAB_TYPE.TESTER)
      )(state);
    case EAT.TABTEST_GENERATED_CPP:
      return R.compose(
        addPlainTextToTesterLog(MSG.TABTEST_BUILDING),
        R.assoc('uploadProgress', 50)
      )(state);
    case EAT.TABTEST_COMPILED:
      return R.compose(
        addPlainTextToTesterLog(MSG.TABTEST_RUNNING),
        R.assoc('uploadProgress', 70)
      )(state);
    case EAT.TABTEST_LAUNCHED:
      return R.assoc('uploadProgress', 90, state);
    case EAT.TABTEST_RUN_FINISHED:
      return R.compose(
        addPlainTextToTesterLog(action.payload.stdout.join('\n')),
        hideProgressBar
      )(state);
    case EAT.TABTEST_ABORT:
      return R.compose(
        addPlainTextToTesterLog(MSG.TABTEST_ABORTED),
        hideProgressBar
      )(state);
    case EAT.TABTEST_ERROR:
      return R.compose(
        overStageError(LOG_TAB_TYPE.TESTER)(
          R.always(formatWasmError(action.payload))
        ),
        hideProgressBar
      )(state);

    case EAT.SIMULATION_RUN_REQUESTED:
      return R.compose(
        overDebuggerLog(R.always(MSG.SIMULATION_GENERATING_CODE)),
        overStageError(LOG_TAB_TYPE.DEBUGGER)(R.always('')),
        R.assoc('uploadProgress', 25),
        R.assoc('isPreparingSimulation', true),
        R.assoc('currentTab', LOG_TAB_TYPE.DEBUGGER)
      )(state);
    case EAT.SIMULATION_GENERATED_CPP:
      return R.compose(
        addPlainTextToDebuggerLog(MSG.SIMULATION_BUILDING),
        R.assoc('uploadProgress', 50)
      )(state);
    case EAT.SIMULATION_COMPILED:
      return R.compose(
        addPlainTextToDebuggerLog(MSG.SIMULATION_RUNNING),
        R.assoc('uploadProgress', 75)
      )(state);
    case EAT.SIMULATION_LAUNCHED: {
      const invertedNodeIdsMap = invertMap(action.payload.nodeIdsMap);
      return R.compose(
        addPlainTextToDebuggerLog(MSG.SIMULATION_LAUNCHED),
        R.assoc('activeSession', SESSION_TYPE.SIMULATON),
        R.assoc('isPreparingSimulation', false),
        R.assoc('isOutdated', false),
        R.assoc('uploadProgress', null),
        R.assoc('tableLogNodeIds', action.payload.tableLogNodeIds),
        R.assoc('nodeIdsMap', invertedNodeIdsMap),
        R.assoc('nodePinKeysMap', action.payload.nodePinKeysMap),
        R.assoc('globals', action.payload.globals),
        rekeyAndAssocPinsAffectedByErrorRaisers(
          invertedNodeIdsMap,
          action.payload.pinsAffectedByErrorRaisers
        )
      )(state);
    }
    case EAT.SIMULATION_ABORT:
      return R.compose(
        addPlainTextToDebuggerLog(MSG.SIMULATION_ABORTED),
        R.assoc('activeSession', SESSION_TYPE.NONE),
        R.assoc('watchNodeValues', {}),
        R.assoc('interactiveErroredNodePins', {}),
        R.assoc('pinsAffectedByErrorRaisers', {}),
        R.assoc('globals', {}),
        R.assoc('isPreparingSimulation', false),
        R.assoc('tetheringInet', DEFAULT_TETHERING_INET_STATE),
        hideProgressBar
      )(state);
    case EAT.SIMULATION_ERROR:
      return R.compose(
        overStageError(LOG_TAB_TYPE.DEBUGGER)(
          R.always(formatWasmError(action.payload))
        ),
        R.assoc('activeSession', SESSION_TYPE.NONE),
        R.assoc('isPreparingSimulation', false),
        R.assoc('globals', {}),
        R.assoc('tetheringInet', DEFAULT_TETHERING_INET_STATE),
        hideProgressBar
      )(state);

    default:
      return state;
  }
};
