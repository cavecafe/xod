import R from 'ramda';
import { createSelector } from 'reselect';
import { getNodes } from './node';
import { getNodeTypes, getPinsByNodeTypeId } from './nodetype';
import * as PIN_DIRECTION from '../constants/pinDirection';
import * as PIN_VALIDITY from '../constants/pinValidity';

export const getPins = (state) => R.pipe(
  R.prop('pins')
)(state);

export const getPinsByNodeId = (state, props) => R.pipe(
  getPins,
  R.filter((pin) => pin.nodeId === props.id)
)(state, props);

export const getPinsByIds = (state, props) => R.pipe(
  getPins,
  R.values,
  R.reduce((p, pin) => {
    let result = p;
    if (props && props.pins && props.pins.indexOf(pin.id) !== -1) {
      result = R.assic(pin.id, pin, p);
    }
    return result;
  }, {})
)(state, props);

export const getFullPinsData = createSelector(
  [getPins, getNodeTypes, getNodes],
  (pins, nodeTypes, nodes) => R.pipe(
    R.values,
    R.reduce((p, pin) => {
      const node = nodes[pin.nodeId];
      const nodeTypePins = getPinsByNodeTypeId({ nodeTypes }, node.typeId);
      const originalPin = nodeTypePins[pin.key];

      return R.assoc(pin.id, R.merge(pin, originalPin), p);
    }, {})
  )(pins)
);

export const getValidPins = (pins, links, forPinId) => {
  const oPin = pins[forPinId];
  return R.pipe(
    R.values,
    R.reduce((p, pin) => {
      const samePin = (pin.id === oPin.id);
      const sameNode = (pin.nodeId === oPin.nodeId);
      const sameDirection = (pin.direction === oPin.direction);
      const sameType = (pin.type === oPin.type);
      const pinLinks = R.pipe(
        R.values,
        R.filter((link) => (link.fromPinId === pin.id || link.toPinId === pin.id))
      )(links);
      const canHaveLink = (
        (
          pin.direction === PIN_DIRECTION.INPUT &&
          pinLinks.length === 0
        ) ||
        pin.direction === PIN_DIRECTION.OUTPUT
      );

      let validness = PIN_VALIDITY.INVALID;


      if (!samePin && !sameNode && canHaveLink) {
        if (!sameDirection) { validness = PIN_VALIDITY.ALMOST; }
        if (!sameDirection && sameType) { validness = PIN_VALIDITY.VALID; }
      }

      const result = {
        id: pin.id,
        validness,
      };

      return R.assoc(pin.id, result, p);
    }, {})
  )(pins);
};
