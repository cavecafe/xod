import * as R from 'ramda';
import { Maybe } from 'ramda-fantasy';
import * as XP from 'xod-project';
import { explodeEither, foldMaybe, maybeProp } from 'xod-func-tools';
import { getLibName } from 'xod-pm';

import * as AT from './actionTypes';
import {
  PASTE_ENTITIES,
  INSTALL_LIBRARIES_COMPLETE,
} from '../editor/actionTypes';

import {
  addPoints,
  slotPositionToPixels,
  snapNodePositionToSlots,
  pixelPositionToSlots,
  getBusNodePositionForPin,
} from './nodeLayout';
import {
  NODE_PROPERTY_KIND,
  NODE_PROPERTY_KEY,
  NODE_KIND,
  MAIN_PATCH_PATH,
} from './constants';

// TODO: rewrite this?
const selectNodePropertyUpdater = ({ kind, key, value = '' }) => {
  if (kind === NODE_PROPERTY_KIND.PIN) {
    return value === ''
      ? XP.removeBoundValue(key)
      : XP.setBoundValue(key, value);
  }

  if (kind === NODE_PROPERTY_KIND.PROP) {
    if (key === NODE_PROPERTY_KEY.LABEL) {
      return XP.setNodeLabel(value);
    } else if (key === NODE_PROPERTY_KEY.DESCRIPTION) {
      return XP.setNodeDescription(value);
    }
  }

  return R.identity;
};

const updateNodeWith = (updaterFn, id, patchPath, state) => {
  const updatedNode = R.compose(
    updaterFn,
    XP.getNodeByIdUnsafe(id),
    XP.getPatchByPathUnsafe(patchPath)
  )(state);

  return R.over(XP.lensPatch(patchPath), XP.assocNode(updatedNode), state);
};

const updateCommentWith = (updaterFn, id, patchPath, state) => {
  const updatedComment = R.compose(
    updaterFn,
    XP.getCommentByIdUnsafe(id),
    XP.getPatchByPathUnsafe(patchPath)
  )(state);

  return R.over(
    XP.lensPatch(patchPath),
    XP.assocComment(updatedComment),
    state
  );
};

const nodePositionLens = R.lens(XP.getNodePosition, XP.setNodePosition);
const commentPositionLens = R.lens(
  XP.getCommentPosition,
  XP.setCommentPosition
);

const moveEntities = (positionLens, deltaPosition) =>
  R.map(
    R.over(
      positionLens,
      R.compose(
        pixelPositionToSlots,
        snapNodePositionToSlots,
        addPoints(deltaPosition),
        slotPositionToPixels
      )
    )
  );

// :: LibName -> Project -> Project
const omitLibPatches = R.curry((libName, project) =>
  R.compose(
    XP.omitPatches(R.__, project),
    R.filter(R.compose(R.equals(libName), XP.getLibraryName)),
    R.map(XP.getPatchPath),
    XP.listLibraryPatches
  )(project)
);

// :: [Patch] -> Project -> Project
const assocPatchListAndMigrate = R.curry((patches, project) =>
  R.pipe(XP.upsertPatches, XP.migrateBoundValuesToBoundLiterals)(
    patches,
    project
  )
);

const addLinkedNode = R.curry(
  (newNode, { patchPath, pinKey, nodeId, pin }, state) => {
    const newPinKey = R.compose(
      foldMaybe('__out__', XP.getPinKey),
      R.chain(maybeProp(0)),
      R.map(
        pin.direction === XP.PIN_DIRECTION.INPUT
          ? XP.listOutputPins
          : XP.listInputPins
      ),
      XP.getPatchByPath(R.__, state),
      XP.getNodeType
    )(newNode);

    const link =
      pin.direction === XP.PIN_DIRECTION.INPUT
        ? XP.createLink(pinKey, nodeId, newPinKey, XP.getNodeId(newNode))
        : XP.createLink(newPinKey, XP.getNodeId(newNode), pinKey, nodeId);

    const conflictingLinks = R.compose(
      XP.listLinksByPin(
        XP.getLinkInputPinKey(link),
        XP.getLinkInputNodeId(link)
      ),
      XP.getPatchByPathUnsafe(patchPath)
    )(state);

    return R.over(
      XP.lensPatch(patchPath),
      R.pipe(
        XP.omitLinks(conflictingLinks),
        XP.assocNode(newNode),
        XP.assocLink(link)
      ),
      state
    );
  }
);

export default (state = {}, action) => {
  switch (action.type) {
    //
    // Project
    //
    case AT.PROJECT_CREATE: {
      const libraryPatches = R.compose(
        R.filter(XP.isGenuinePatch),
        XP.listLibraryPatches
      )(state);

      const mainPatch = XP.setPatchPath(MAIN_PATCH_PATH, XP.createPatch());

      const newProject = XP.createProject();

      return XP.mergePatchesList([mainPatch, ...libraryPatches], newProject);
    }

    case AT.PROJECT_IMPORT: {
      const importedProject = action.payload;
      return assocPatchListAndMigrate(
        XP.listLibraryPatches(state),
        importedProject
      );
    }

    case AT.PROJECT_OPEN: {
      return action.payload;
    }

    case AT.PROJECT_UPDATE_META: {
      // Update Project meta property only if needed
      const updateMeta = R.curry((propName, setterFn, _state) =>
        R.when(
          () => R.has(propName, action.payload),
          setterFn(action.payload[propName])
        )(_state)
      );
      return R.compose(
        updateMeta('name', XP.setProjectName),
        updateMeta('version', XP.setProjectVersion),
        updateMeta('license', XP.setProjectLicense),
        updateMeta('description', XP.setProjectDescription),
        updateMeta('apiKey', XP.setApiKey)
      )(state);
    }

    case AT.PROJECT_OPEN_WORKSPACE: {
      const libs = action.payload;

      return R.compose(
        XP.mergePatchesList(libs),
        XP.setProjectName('untitled'),
        XP.createProject
      )();
    }

    //
    // Patch
    //
    case AT.PATCH_ADD: {
      const { patchPath } = action.payload;

      const patch = XP.createPatch();

      return XP.assocPatch(patchPath, patch, state);
    }

    case AT.PATCH_RENAME: {
      const { newPatchPath, oldPatchPath } = action.payload;
      return explodeEither(XP.rebasePatch(newPatchPath, oldPatchPath, state));
    }

    case AT.PATCH_CLONE: {
      const { patchPath, originalPatchPath } = action.payload;
      return explodeEither(XP.clonePatch(originalPatchPath, patchPath, state));
    }

    case AT.PATCH_DELETE: {
      const { patchPath } = action.payload;

      return XP.dissocPatch(patchPath, state);
    }

    case AT.PATCH_DESCRIPTION_UPDATE: {
      const { patchPath, description } = action.payload;
      const patchLens = XP.lensPatch(patchPath);
      return R.over(patchLens, XP.setPatchDescription(description), state);
    }

    case AT.PATCH_MANAGED_ATTACHMENT_UPDATE: {
      const { patchPath, newContents, markerName } = action.payload;
      const patchLens = XP.lensPatch(patchPath);
      return R.over(
        patchLens,
        XP.setAttachmentManagedByMarker(markerName, newContents),
        state
      );
    }

    case INSTALL_LIBRARIES_COMPLETE: {
      const patches = R.compose(
        R.unnest,
        R.values,
        R.mapObjIndexed((proj, name) =>
          R.compose(
            XP.prepareLibPatchesToInsertIntoProject(R.__, proj),
            getLibName
          )(name)
        )
      )(action.payload.projects);

      const libNames = R.compose(R.map(getLibName), R.keys)(
        action.payload.projects
      );

      return R.compose(
        assocPatchListAndMigrate(patches),
        R.reduce(R.flip(omitLibPatches), R.__, libNames)
      )(state);
    }

    //
    // Bulk actions on multiple entities
    //
    case AT.BULK_MOVE_NODES_AND_COMMENTS: {
      const { nodeIds, commentIds, deltaPosition, patchPath } = action.payload;

      const currentPatchLens = XP.lensPatch(patchPath);
      const patch = R.view(currentPatchLens, state);

      const movedNodes = R.compose(
        moveEntities(nodePositionLens, deltaPosition),
        R.map(R.flip(XP.getNodeByIdUnsafe)(patch))
      )(nodeIds);

      const movedComments = R.compose(
        moveEntities(commentPositionLens, deltaPosition),
        R.map(R.flip(XP.getCommentByIdUnsafe)(patch))
      )(commentIds);

      return R.over(
        currentPatchLens,
        R.compose(XP.upsertComments(movedComments), XP.upsertNodes(movedNodes)),
        state
      );
    }

    case AT.BULK_DELETE_ENTITIES: {
      const { linkIds, nodeIds, commentIds, patchPath } = action.payload;

      const dissocFns = R.unnest([
        R.map(XP.dissocLink, linkIds),
        R.map(XP.dissocNode, nodeIds),
        R.map(XP.dissocComment, commentIds),
      ]);

      return R.over(
        XP.lensPatch(patchPath),
        patch => R.reduce((p, fn) => fn(p), patch, dissocFns),
        state
      );
    }

    case PASTE_ENTITIES: {
      const { entities, patchPath } = action.payload;

      return R.over(
        XP.lensPatch(patchPath),
        R.compose(
          XP.upsertLinks(entities.links),
          XP.upsertComments(entities.comments),
          XP.upsertNodes(entities.nodes),
          R.reduce(
            (patch, [markerPath, attachmentContents]) => {
              const existingMarkerNode = R.compose(
                R.find(R.pipe(XP.getNodeType, R.equals(markerPath))),
                XP.listNodes
              )(patch);

              return R.compose(
                XP.setAttachmentManagedByMarker(markerPath, attachmentContents),
                existingMarkerNode
                  ? XP.dissocNode(existingMarkerNode)
                  : R.identity
              )(patch);
            },
            R.__,
            entities.attachments
          )
        ),
        state
      );
    }

    //
    // Node
    //
    case AT.NODE_ADD: {
      const { typeId, position, newNodeId, patchPath } = action.payload;

      const newNode = R.compose(
        R.assoc('id', newNodeId), // TODO: who should handle id generation?
        XP.createNode
      )(position, typeId);

      return R.over(
        XP.lensPatch(patchPath), // TODO: can we have a situation where patch does not exist?
        XP.assocNode(newNode),
        state
      );
    }

    case AT.NODE_PROPERTY_UPDATED: {
      const { id, patchPath } = action.payload;

      const currentPatchLens = XP.lensPatch(patchPath);

      const node = R.compose(
        XP.getNodeByIdUnsafe(id),
        R.view(currentPatchLens)
      )(state);

      return R.over(
        currentPatchLens,
        XP.assocNode(selectNodePropertyUpdater(action.payload)(node)),
        state
      );
    }

    case AT.NODE_CHANGE_ARITY_LEVEL: {
      const { nodeId, arityLevel, patchPath } = action.payload;
      const currentPatchLens = XP.lensPatch(patchPath);
      const updatedNode = R.compose(
        XP.setNodeArityLevel(arityLevel),
        XP.getNodeByIdUnsafe(nodeId),
        XP.getPatchByPathUnsafe(patchPath)
      )(state);

      return R.over(
        currentPatchLens,
        R.compose(
          XP.omitDeadLinksByNodeId(nodeId, R.__, state),
          XP.assocNode(updatedNode)
        ),
        state
      );
    }

    case AT.NODE_CHANGE_SPECIALIZATION: {
      const { nodeId, patchPath, nodeType } = action.payload;

      return XP.changeNodeTypeUnsafe(patchPath, nodeId, nodeType, state);
    }

    case AT.NODE_RESIZE: {
      const { id, patchPath, size } = action.payload;

      return updateNodeWith(XP.setNodeSize(size), id, patchPath, state);
    }

    //
    // Link
    //
    case AT.LINK_ADD: {
      const { pins, patchPath } = action.payload;

      const firstPinNode = R.compose(
        XP.getNodeByIdUnsafe(pins[0].nodeId),
        R.view(XP.lensPatch(patchPath))
      )(state);

      const firstPinNodeType = XP.getNodeType(firstPinNode);
      const firstPinPatch = XP.getPatchByPathUnsafe(firstPinNodeType, state);

      const inputPinIndex = R.compose(
        R.ifElse(XP.isInputPin, R.always(0), R.always(1)),
        R.prop(pins[0].pinKey),
        XP.getPinsForNode(firstPinNode, firstPinPatch)
      )(state);

      const input = pins[inputPinIndex];
      const output = pins[1 - inputPinIndex];

      const oldLinks = R.compose(
        XP.listLinksByPin(input.pinKey, input.nodeId),
        XP.getPatchByPathUnsafe(patchPath)
      )(state);

      const newLink = XP.createLink(
        input.pinKey,
        input.nodeId,
        output.pinKey,
        output.nodeId
      );

      return R.over(
        XP.lensPatch(patchPath),
        R.pipe(XP.omitLinks(oldLinks), XP.assocLink(newLink)),
        state
      );
    }

    case AT.LINKS_SPLIT_TO_BUSES: {
      const { patchPath, linkIds } = action.payload;

      return XP.splitLinksToBuses(
        getBusNodePositionForPin,
        patchPath,
        linkIds,
        state
      );
    }

    case AT.ADD_LINKED_NODE: {
      const { nodeKind, node, pin, position } = action.payload;

      const newNode = (() => {
        switch (nodeKind) {
          case NODE_KIND.BUS: {
            const newNodeType =
              pin.direction === XP.PIN_DIRECTION.INPUT
                ? XP.FROM_BUS_PATH
                : XP.TO_BUS_PATH;
            const label = XP.isPinNode(node)
              ? XP.getNodeLabel(node)
              : XP.getPinLabel(pin);
            return R.compose(XP.setNodeLabel(label), XP.createNode)(
              position,
              newNodeType
            );
          }
          case NODE_KIND.TERMINAL: {
            const newNodeType = XP.getTerminalPath(pin.direction, pin.type);
            const label = XP.isPinNode(node)
              ? XP.getNodeLabel(node)
              : XP.getPinLabel(pin);
            return R.compose(XP.setNodeLabel(label), XP.createNode)(
              position,
              newNodeType
            );
          }
          case NODE_KIND.CONSTANT: {
            return foldMaybe(
              state,
              newNodeType => {
                const outputPinKey = R.compose(
                  foldMaybe('__out__', XP.getPinKey),
                  R.chain(maybeProp(0)),
                  R.map(XP.listOutputPins),
                  XP.getPatchByPath(newNodeType)
                )(state);

                return R.compose(
                  XP.setBoundValue(outputPinKey, pin.value),
                  XP.createNode
                )(position, newNodeType);
              },
              XP.getConstantNodeType(pin.type)
            );
          }
          case NODE_KIND.INTERACTIVE: {
            const newNodeType =
              pin.direction === XP.PIN_DIRECTION.INPUT
                ? XP.getTweakPatchPath(pin.type)
                : Maybe.of(XP.WATCH_NODETYPE);

            return foldMaybe(
              state,
              type => {
                const outputPinKey = R.compose(
                  foldMaybe('__out__', XP.getPinKey),
                  R.chain(maybeProp(0)),
                  R.map(XP.listOutputPins),
                  XP.getPatchByPath(type)
                )(state);

                return R.compose(
                  XP.setBoundValue(outputPinKey, pin.value),
                  XP.createNode
                )(position, type);
              },
              newNodeType
            );
          }
          default:
            return R.compose(XP.createNode)(position, pin.type);
        }
      })();

      return addLinkedNode(newNode, action.payload, state);
    }

    //
    // Comment
    //
    case AT.COMMENT_ADD: {
      const { patchPath } = action.payload;

      const newComment = XP.createComment(
        { x: 1, y: 1 },
        { width: 4, height: 1 },
        'Double-click to edit comment'
      );

      return R.over(
        XP.lensPatch(patchPath),
        XP.assocComment(newComment),
        state
      );
    }

    case AT.COMMENT_RESIZE: {
      const { id, patchPath, size } = action.payload;

      return updateCommentWith(XP.setCommentSize(size), id, patchPath, state);
    }

    case AT.COMMENT_SET_CONTENT: {
      const { id, patchPath, content } = action.payload;

      return updateCommentWith(
        XP.setCommentContent(content),
        id,
        patchPath,
        state
      );
    }

    case AT.PROJECT_SET_API_KEY:
      return XP.setApiKey(action.payload, state);

    default:
      return state;
  }
};
