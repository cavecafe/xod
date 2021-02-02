import * as R from 'ramda';
import { Maybe } from 'ramda-fantasy';
import { failOnFalse, maybePath, isAmong } from 'xod-func-tools';

import { def } from './types';
import * as CONST from './constants';
import { isBuiltInType, isGenericType } from './utils';
import {
  isPathLocal,
  isPathLibrary,
  isValidPatchPath,
  isValidPatchBasename,
  terminalPatchPathRegExp,
} from './internal/patchPathUtils';
import { BINDABLE_CUSTOM_TYPES_LIST } from './custom-types';

export {
  isLocalMarker,
  isValidIdentifier,
  isValidPatchBasename,
  isSpecializationPatchBasename,
  isExpandedVariadicPatchBasename,
  isPathLocal,
  isPathLibrary,
  isLibName,
  isValidPatchPath,
  isTerminalPatchPath,
  isWatchPatchPath,
  isTableLogPatchPath,
  isFromBusPatchPath,
  isToBusPatchPath,
  isBusPatchPath,
  isJumperPatchPath,
  isBuiltInLibName,
  getExpandedVariadicPatchPath,
  getSpecializationSuffix,
} from './internal/patchPathUtils';

// :: String -> Identifier
export const toIdentifier = R.compose(
  R.replace(/-$/g, ''),
  R.replace(/^-/g, ''),
  R.replace(/(-)\1+/g, '-'),
  R.replace(/[^a-z0-9]/gi, '-'),
  R.toLower
);

//
// general-purpose utils
//

export const getLocalPath = baseName => `@/${baseName}`;

/**
 * Checks if a path is a valid for entities like
 * project path, patch path component, etc
 *
 * @function validatePath
 * @param {string} path - string to check
 * @returns {Either<Error|string>} error or valid path
 */
export const validatePath = patchPath =>
  failOnFalse('INVALID_PATCH_PATH', { patchPath }, isValidPatchPath)(patchPath);

/**
 * User-defined patch names can't begin with `input-` or `output-`.
 * Those are reserved for terminals, which are auto-generated.
 */
const reservedBaseNameRegExp = R.compose(
  dirs => new RegExp(`^(${dirs})-`),
  R.join('|'),
  R.values
)(CONST.PIN_DIRECTION);
export const isValidUserDefinedPatchBasename = R.both(
  isValidPatchBasename,
  R.complement(R.test(reservedBaseNameRegExp))
);

/**
 * @function getBaseName
 * @param {string} path
 * @returns {string}
 */
export const getBaseName = R.compose(R.last, R.split('/'));

// :: PatchPath -> Identifier
export const getBaseNameWithoutTypes = R.compose(
  R.head,
  R.split('('),
  getBaseName
);

/**
 * @function getLibraryName
 * @param {string} path
 * @returns {string}
 */
export const getLibraryName = R.ifElse(
  isPathLibrary,
  R.compose(R.join('/'), R.take(2), R.split('/')),
  R.always('@')
);

// :: PatchPath -> String
export const getOwnerName = R.compose(R.head, R.split('/'));

/**
 * Converts `xod/core/something` into `@/something`,
 * `@/another-one` will be unchanged.
 */
export const convertToLocalPath = R.compose(getLocalPath, getBaseName);

//
// Utils for terminal patches
//

const PATCH_NODES_LIB_NAME = 'xod/patch-nodes';
const dataTypes = R.values(CONST.PIN_TYPE);

// :: Map BaseName PatchPath
const bindableCustomTypesMap = R.compose(R.mergeAll, R.indexBy(getBaseName))(
  BINDABLE_CUSTOM_TYPES_LIST
);
const bindableTypes = R.compose(R.concat(dataTypes), R.keys)(
  bindableCustomTypesMap
);

// :: String -> Direction
export const getTerminalDirection = R.compose(
  R.nth(1),
  R.match(terminalPatchPathRegExp)
);

export const getTerminalDataType = def(
  'getTerminalDataType :: PatchPath -> DataType',
  terminalPatchPath => {
    const baseType = R.match(terminalPatchPathRegExp, terminalPatchPath)[2];

    // using isBuiltInType from ./utils here won't catch
    // stuff like `someone/my-lib/number`
    const isBuiltInPrimitiveType = R.startsWith(
      `${PATCH_NODES_LIB_NAME}/`,
      terminalPatchPath
    );

    return isBuiltInPrimitiveType
      ? baseType
      : `${getLibraryName(terminalPatchPath)}/${baseType}`;
  }
);

// :: String -> Boolean
export const isInputTerminalPath = R.compose(
  R.equals(CONST.PIN_DIRECTION.INPUT),
  getTerminalDirection
);

// :: String -> Boolean
export const isOutputTerminalPath = R.compose(
  R.equals(CONST.PIN_DIRECTION.OUTPUT),
  getTerminalDirection
);

// :: PinDirection -> DataType -> PatchPath
export const getTerminalPath = R.curry((direction, type) => {
  if (isBuiltInType(type)) {
    return `${PATCH_NODES_LIB_NAME}/${direction}-${type}`;
  }

  // for complex types, `type` is a path to constructor patch
  const constructorLibraryName = getLibraryName(type);
  const constructorBaseName = getBaseName(type);

  return `${constructorLibraryName}/${direction}-${constructorBaseName}`;
});

// :: PatchPath -> PatchPath
export const getUnpackRecordPath = R.compose(
  // basename => `@/unpack-${basename}`,
  R.converge((lib, basename) => `${lib}/unpack-${basename}`, [
    getLibraryName,
    getBaseName,
  ])
);

// :: PatchPath -> PatchPath
export const getToJsonRecordPath = R.compose(
  // basename => `@/to-json(${basename})`,
  R.converge((lib, basename) => `${lib}/to-json(${basename})`, [
    getLibraryName,
    getBaseName,
  ])
);

export const normalizeTypeNameForAbstractsResolution = R.unless(
  t => isBuiltInType(t),
  // for complex types matching is done by
  // a type basename (color, not bob/fun/color)
  getBaseName
);

//
// utils for variadic marker nodes
//

const variadicRegExp = new RegExp(`^${PATCH_NODES_LIB_NAME}/variadic-([1-3])`);

// :: PatchPath -> Boolean
export const isVariadicPath = R.test(variadicRegExp);

// :: PatchPath -> ArityStep
export const getArityStepFromPatchPath = R.compose(
  x => parseInt(x, 10),
  R.nth(1),
  R.match(variadicRegExp)
);

// :: NonZeroNaturalNumber -> PatchPath
export const getVariadicPath = n => `${PATCH_NODES_LIB_NAME}/variadic-${n}`;

//
// utils for cast patches
//

/**
 * Returns path for casting patch
 * @function getCastPatchPath
 * @param {PIN_TYPE} typeIn
 * @param {PIN_TYPE} typeOut
 * @returns {Maybe<PatchPath>}
 */
export const getCastPatchPath = (typeIn, typeOut) =>
  maybePath([typeIn, typeOut], CONST.CAST_NODES);

//
// defer-* nodes
//

const legacyDeferNodeRegExp = new RegExp(
  `^xod/core/defer-(${dataTypes.join('|')})$`
);
// TODO: when custom types will be added this should be generalized
const deferNodeSpecializationRegExp = new RegExp(
  `^xod/core/defer\\((${dataTypes.join('|')})\\)$`
);

// :: PatchPath -> Boolean
export const isDeferNodeType = R.anyPass([
  R.equals('xod/core/defer'),
  R.test(deferNodeSpecializationRegExp),
  R.test(legacyDeferNodeRegExp),
]);

//
// constant-* nodes
//

// TODO: this gives a false positive for `xod/core/constant-pulse`
const constantNodeRegExp = new RegExp(
  `^xod/core/constant-(${dataTypes.join('|')})$`
);

// :: PatchPath -> Boolean
export const isConstantNodeType = R.test(constantNodeRegExp);

// :: DataType -> Maybe PatchPath
export const getConstantNodeType = R.compose(
  Maybe.toMaybe,
  R.cond([
    [isGenericType, R.always(null)],
    [isBuiltInType, R.prop(R.__, CONST.CONST_NODETYPES)],
    [R.T, R.identity],
  ])
);

//
// utils for 'internal' terminals (used only in flatten)
//

export const getInternalTerminalPath = def(
  'getInternalTerminalPath :: DataType -> PatchPath',
  type => `xod/internal/terminal-${type}`
);

// :: String -> String
export const convertToInternalTerminalPath = R.compose(
  getInternalTerminalPath,
  // we can safely convert custom terminals to generics
  // since they never have bound values
  R.unless(t => isBuiltInType(t), R.always(CONST.PIN_TYPE.T1)),
  getTerminalDataType
);

const internalTerminalRegExp = new RegExp(
  `^xod/internal/terminal-(${dataTypes.join('|')})$`
);

// :: PatchPath -> Boolean
export const isInternalTerminalPatchPath = R.test(internalTerminalRegExp);

// :: PatchPath -> Boolean
export const isInternalGenericPatchPath = R.compose(
  isAmong([CONST.PIN_TYPE.T1, CONST.PIN_TYPE.T2, CONST.PIN_TYPE.T3]),
  R.nth(1),
  R.match(internalTerminalRegExp)
);

// :: PatchPath -> Boolean
export const isTerminalSelf = R.equals(CONST.OUTPUT_SELF_PATH);

export const resolvePatchPath = def(
  'resolvePatchPath :: PatchPath -> PatchPath -> PatchPath',
  R.cond([
    [(...args) => R.all(isPathLocal)(args), R.nthArg(0)],
    [(...args) => R.all(isPathLibrary)(args), R.nthArg(0)],
    [
      R.compose(isPathLibrary, R.nthArg(1)),
      (p1, p2) => `${getLibraryName(p2)}/${getBaseName(p1)}`,
    ],
    [R.compose(isPathLocal, R.nthArg(1)), R.nthArg(0)],
  ])
);

//
// utils for abstract nodes
//

// :: PatchPath -> [DataType] -> PatchPath
export const getSpecializationPatchPath = R.curry(
  (abstractPatchBaseName, types) =>
    `${abstractPatchBaseName}(${types.join(',')})`
);

//
// utils for tweak nodes
//

const tweakPathRegExp = new RegExp(
  `^xod/debug/tweak-(${bindableTypes.join('|')})`
);

// :: DataType -> Maybe PatchPath
export const getTweakPatchPath = R.ifElse(
  R.both(isAmong(bindableTypes), R.complement(isGenericType)),
  type =>
    Maybe.of(
      type === CONST.PIN_TYPE.STRING
        ? 'xod/debug/tweak-string-16'
        : `xod/debug/tweak-${type}`
    ),
  Maybe.Nothing
);

// :: PatchPath -> Boolean
export const isTweakPath = R.test(tweakPathRegExp);

// :: PatchPath -> DataType
export const getTweakType = R.compose(
  R.when(
    R.has(R.__, bindableCustomTypesMap),
    R.prop(R.__, bindableCustomTypesMap)
  ),
  R.nth(1),
  R.match(tweakPathRegExp)
);

export const getStringTweakLength = R.pipe(
  R.match(/^xod\/debug\/tweak-string-(\d+)/),
  R.nth(1),
  n => parseInt(n, 10)
);

// :: PatchPath -> Boolean
export const isTetheringInetPatchPath = R.equals(CONST.TETHERING_INET_PATH);
