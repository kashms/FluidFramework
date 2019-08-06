/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { PrimedComponent, SharedComponentFactory } from "@prague/aqueduct";
import { IComponent, IComponentHTMLOptions } from "@prague/component-core-interfaces";
import { randomId, TokenList } from "@prague/flow-util";
import { MapExtension } from "@prague/map";
import {
    BaseSegment,
    Client,
    createInsertSegmentOp,
    createRemoveRangeOp,
    IMergeTreeRemoveMsg,
    ISegment,
    LocalReference,
    Marker,
    MergeTreeDeltaType,
    PropertySet,
    ReferencePosition,
    ReferenceType,
    reservedMarkerIdKey,
    reservedRangeLabelsKey,
    reservedTileLabelsKey,
    TextSegment,
} from "@prague/merge-tree";
import { IComponentContext, IComponentRuntime } from "@prague/runtime-definitions";
import { SequenceDeltaEvent, SharedString, SharedStringExtension } from "@prague/sequence";
import * as assert from "assert";
import { emptyArray } from "../util";
import { Tag } from "../util/tag";
import { debug } from "./debug";
import { SegmentSpan } from "./segmentspan";

export { SegmentSpan };

export const enum DocSegmentKind {
    text        = "text",
    paragraph   = "<p>",
    lineBreak   = "<br>",
    beginTags   = "<t>",
    inclusion   = "<?>",
    endTags     = "</>",

    // Special case for LocalReference to end of document.  (See comments on 'endOfTextSegment').
    endOfText   = "eot",
}

const tilesAndRanges = new Set([ DocSegmentKind.paragraph, DocSegmentKind.lineBreak, DocSegmentKind.beginTags, DocSegmentKind.inclusion ]);

const enum Workaround { checkpoint = "*" }

export const enum DocTile {
    paragraph = DocSegmentKind.paragraph,
    checkpoint = Workaround.checkpoint,
}

// tslint:disable:no-bitwise
export const getDocSegmentKind = (segment: ISegment): DocSegmentKind => {
    // Special case for LocalReference to end of document.  (See comments on 'endOfTextSegment').
    if (segment === endOfTextSegment) {
        return DocSegmentKind.endOfText;
    }

    if (TextSegment.is(segment)) {
        return DocSegmentKind.text;
    } else if (Marker.is(segment)) {
        const markerType = segment.refType;
        switch (markerType) {
            case ReferenceType.Tile:
            case ReferenceType.Tile | ReferenceType.NestBegin:
                const rangeLabel = segment.getRangeLabels()[0];
                const kind = (rangeLabel || segment.getTileLabels()[0]) as DocSegmentKind;

                assert(tilesAndRanges.has(kind), `Unknown tile/range label '${kind}'.`);

                return kind;
            default:
                assert(markerType === (ReferenceType.Tile | ReferenceType.NestEnd));

                // Ensure that 'nestEnd' range label matches the 'beginTags' range label (otherwise it
                // will not close the range.)
                assert.strictEqual(segment.getRangeLabels()[0], DocSegmentKind.beginTags, `Unknown refType '${markerType}'.`);
                return DocSegmentKind.endTags;
        }
    }
};

const empty = Object.freeze({});

export function getCss(segment: ISegment): Readonly<{ style?: string, classList?: string }> {
    return segment.properties || empty;
}

export function getComponentOptions(segment: ISegment): IComponentHTMLOptions | undefined {
    return (segment.properties && segment.properties.componentOptions) || empty;
}

type LeafAction = (position: number, segment: ISegment, startOffset: number, endOffset: number) => boolean;

/**
 * Used by 'FlowDocument.visitRange'.  Uses the otherwise unused 'accum' object to pass the
 * leaf action callback, allowing us to simplify the the callback signature and while (maybe)
 * avoiding unnecessary allocation to wrap the given 'callback'.
 */
const accumAsLeafAction = {
    leaf: (
        segment: ISegment,
        position: number,
        refSeq: number,
        clientId: number,
        startOffset: number,
        endOffset: number,
        accum?: LeafAction,
    ) => (accum as LeafAction)(position, segment, startOffset, endOffset),
};

// TODO: We need the ability to create LocalReferences to the end of the document. Our
//       workaround creates a LocalReference with an 'undefined' segment that is never
//       inserted into the MergeTree.  We then special case this segment in localRefToPosition,
//       addLocalRef, removeLocalRef, etc.
//
//       Note, we use 'undefined' for our sentinel value to also workaround the case where
//       the user deletes the entire sequence.  (The SlideOnRemove references end up pointing
//       to undefined segments.)
//
//       See: https://github.com/microsoft/Prague/issues/2408
const endOfTextSegment = undefined as unknown as BaseSegment;

export class FlowDocument extends PrimedComponent {
    private get sharedString() { return this.maybeSharedString; }
    private get mergeTree() { return this.maybeClient.mergeTree; }
    private get clientId() { return this.maybeClient.getClientId(); }
    private get currentSeq() { return this.maybeClient.getCurrentSeq(); }

    public get length() {
        return this.mergeTree.getLength(this.currentSeq, this.clientId);
    }

    public static readonly type = "@chaincode/flow-document";

    private static readonly paragraphProperties = Object.freeze({ [reservedTileLabelsKey]: [DocSegmentKind.paragraph, DocTile.checkpoint], tag: Tag.p });
    private static readonly lineBreakProperties = Object.freeze({ [reservedTileLabelsKey]: [DocSegmentKind.lineBreak, DocTile.checkpoint] });
    private static readonly inclusionProperties = Object.freeze({ [reservedTileLabelsKey]: [DocSegmentKind.inclusion, DocTile.checkpoint] });
    private static readonly tagsProperties      = Object.freeze({
        [reservedTileLabelsKey]: [DocSegmentKind.inclusion, DocTile.checkpoint],
        [reservedRangeLabelsKey]: [DocSegmentKind.beginTags],
    });

    private maybeSharedString?: SharedString;
    private maybeClient?: Client;

    constructor(runtime: IComponentRuntime, context: IComponentContext) {
        super(runtime, context);
    }

    public async getComponentFromMarker(marker: Marker) {
        const url = marker.properties.url as string;

        const response = await this.context.hostRuntime.request({ url });
        if (response.status !== 200 || response.mimeType !== "prague/component") {
            return Promise.reject("Not found");
        }

        return response.value as IComponent;
    }

    public getSegmentAndOffset(position: number) {
        // Special case for LocalReference to end of document.  (See comments on 'endOfTextSegment').
        return position === this.length
            ? { segment: endOfTextSegment, offset: 0 }
            : this.sharedString.getContainingSegment(position);
    }

    public getPosition(segment: ISegment) {
        // Special case for LocalReference to end of document.  (See comments on 'endOfTextSegment').
        return segment === endOfTextSegment
            ? this.length
            : this.mergeTree.getPosition(segment, this.currentSeq, this.clientId);
    }

    public addLocalRef(position: number) {
        // Special case for LocalReference to end of document.  (See comments on 'endOfTextSegment').
        if (position >= this.length) {
            return new LocalReference(endOfTextSegment);
        }

        const { segment, offset } = this.getSegmentAndOffset(position);
        const localRef = new LocalReference(segment as BaseSegment, offset, ReferenceType.SlideOnRemove);
        this.mergeTree.addLocalReference(localRef);
        return localRef;
    }

    public removeLocalRef(localRef: LocalReference) {
        const segment = localRef.getSegment();

        // Special case for LocalReference to end of document.  (See comments on 'endOfTextSegment').
        if (segment !== endOfTextSegment) {
            this.mergeTree.removeLocalReference(segment, localRef);
        }
    }

    public localRefToPosition(localRef: LocalReference) {
        // Special case for LocalReference to end of document.  (See comments on 'endOfTextSegment').
        if (localRef.getSegment() === endOfTextSegment) {
            return this.length;
        }

        return localRef.toPosition(this.mergeTree, this.currentSeq, this.clientId);
    }

    public insertText(position: number, text: string) {
        debug(`insertText(${position},"${text}")`);
        this.sharedString.insertText(position, text);
    }

    public replaceWithText(start: number, end: number, text: string) {
        debug(`replaceWithText(${start}, ${end}, "${text}")`);
        this.sharedString.replaceText(start, end, text);
    }

    public remove(start: number, end: number) {
        debug(`remove(${start},${end})`);
        const ops: IMergeTreeRemoveMsg[] = [];

        this.visitRange((position: number, segment: ISegment) => {
            switch (getDocSegmentKind(segment)) {
                case DocSegmentKind.beginTags: {
                    // Removing a start tag implicitly removes its matching end tag.
                    // Check if the end tag is already included in the range being removed.
                    const endTag = this.getEnd(segment as Marker);
                    const endPos = this.getPosition(endTag);

                    // Note: The end tag must appear after the position of the current start tag.
                    console.assert(position < endPos);

                    if (!(endPos < end)) {
                        // If not, add the end tag removal to the group op.
                        debug(`  also remove end tag '</${endTag.properties.tag}>' at ${endPos}.`);
                        ops.push(createRemoveRangeOp(endPos, endPos + 1));
                    }
                    break;
                }
                case DocSegmentKind.endTags: {
                    // The end tag should be preserved unless the start tag is also included in
                    // the removed range.  Check if range being removed includes the start tag.
                    const startTag = this.getStart(segment as Marker);
                    const startPos = this.getPosition(startTag);

                    // Note: The start tag must appear before the position of the current end tag.
                    console.assert(startPos < position);

                    if (!(start <= startPos)) {
                        // If not, remove any positions up to, but excluding the current segment
                        // and adjust the pending removal range to just after this marker.
                        debug(`  exclude end tag '</${segment.properties.tag}>' at ${position}.`);
                        ops.push(createRemoveRangeOp(start, position));
                        start = position + 1;
                    }
                    break;
                }
                default:
            }
            return true;
        }, start, end);

        if (start !== end) {
            ops.push(createRemoveRangeOp(start, end));
        }

        // Perform removals in descending order, otherwise earlier deletions will shift the positions
        // of later ops.  Because each effected interval is non-overlapping, a simple sort suffices.
        ops.sort((left, right) => right.pos1 - left.pos1);

        this.sharedString.groupOperation({
            ops,
            type: MergeTreeDeltaType.GROUP,
        });
    }

    public insertParagraph(position: number, tag?: Tag) {
        debug(`insertParagraph(${position})`);
        this.sharedString.insertMarker(position, ReferenceType.Tile, Object.freeze({ ...FlowDocument.paragraphProperties, tag }));
    }

    public insertLineBreak(position: number) {
        debug(`insertLineBreak(${position})`);
        this.sharedString.insertMarker(position, ReferenceType.Tile, FlowDocument.lineBreakProperties);
    }

    public insertComponent(position: number, url: string, componentOptions: object, style?: string, classList?: string[]) {
        this.sharedString.insertMarker(position, ReferenceType.Tile, Object.freeze({ ...FlowDocument.inclusionProperties,
            componentOptions, url, style, classList: classList && classList.join(" ") }));
    }

    public setFormat(position: number, tag: Tag) {
        const { start } = this.findParagraph(position);

        // If inside an existing paragraph marker, update it with the new formatting tag.
        if (start < this.length) {
            const pgSeg = this.getSegmentAndOffset(start).segment;
            if (getDocSegmentKind(pgSeg) === DocSegmentKind.paragraph) {
                pgSeg.properties.tag = tag;
                this.annotate(start, start + 1, { tag });
                return;
            }
        }

        // Otherwise, insert a new paragraph marker.
        this.insertParagraph(start, tag);
    }

    public insertTags(tags: Tag[], start: number, end = start) {
        const ops = [];
        const id = randomId();

        const endMarker = new Marker(ReferenceType.Tile | ReferenceType.NestEnd);
        endMarker.properties = Object.freeze({ ...FlowDocument.tagsProperties, [reservedMarkerIdKey]: `end-${id}` });
        ops.push(createInsertSegmentOp(end, endMarker));

        const beginMarker = new Marker(ReferenceType.Tile | ReferenceType.NestBegin);
        beginMarker.properties = Object.freeze({ ...FlowDocument.tagsProperties, tags, [reservedMarkerIdKey]: `begin-${id}` });
        ops.push(createInsertSegmentOp(start, beginMarker));

        // Note: Insert the endMarker prior to the beginMarker to avoid needing to compensate for the
        //       change in positions.
        this.sharedString.groupOperation({
            ops,
            type: MergeTreeDeltaType.GROUP,
        });
    }

    public getTags(position: number): Readonly<Marker[]> {
        const tags = this.mergeTree.getStackContext(position, this.clientId, [DocSegmentKind.beginTags])[DocSegmentKind.beginTags];
        return (tags && tags.items) || emptyArray;
    }

    public getStart(marker: Marker) {
        return this.getOppositeMarker(marker, /* "end".length = */ 3, "begin");
    }

    public getEnd(marker: Marker) {
        return this.getOppositeMarker(marker, /* "begin".length = */ 5, "end");
    }

    public annotate(start: number, end: number, props: PropertySet) {
        this.sharedString.annotateRange(start, end, props);
    }

    public addCssClass(start: number, end: number, ...classNames: string[]) {
        if (classNames.length > 0) {
            const newClasses = classNames.join(" ");
            this.updateCssClassList(start, end, (classList) => TokenList.set(classList, newClasses));
        }
    }

    public removeCssClass(start: number, end: number, ...classNames: string[]) {
        this.updateCssClassList(start, end,
            (classList) => classNames.reduce(
                (updatedList, className) => TokenList.unset(updatedList, className),
                classList));
    }

    public toggleCssClass(start: number, end: number, ...classNames: string[]) {
        // Pre-visit the range to see if any of the new styles have already been set.
        // If so, change the add to a removal by setting the map value to 'undefined'.
        const toAdd = classNames.slice(0);
        const toRemove = new Set<string>();

        this.updateCssClassList(start, end,
            (classList) => {
                TokenList.computeToggle(classList, toAdd, toRemove);
                return classList;
            });

        this.removeCssClass(start, end, ...toRemove);
        this.addCssClass(start, end, ...toAdd);
    }

    public findTile(position: number, tileType: DocTile, preceding: boolean): { tile: ReferencePosition, pos: number } {
        return this.mergeTree.findTile(position, this.clientId, tileType as unknown as string, preceding);
    }

    public findParagraph(position: number) {
        const maybeStart = this.findTile(position, DocTile.paragraph, /* preceding: */ true);
        const start = maybeStart ? maybeStart.pos : 0;

        const maybeEnd = this.findTile(position, DocTile.paragraph, /* preceding: */ false);
        const end = maybeEnd ? maybeEnd.pos + 1 : this.length;

        return { start, end };
    }

    public visitRange(callback: LeafAction, start = 0, end = +Infinity) {
        // Early exit if passed an empty or invalid range (e.g., NaN).
        if (!(start < end)) {
            return;
        }

        // Note: We pass the leaf callback action as the accumulator, and then use the 'accumAsLeafAction'
        //       actions to invoke the accum for each leaf.  (Paranoid micro-optimization that attempts to
        //       avoid allocation while simplifying the 'LeafAction' signature.)
        this.mergeTree.mapRange(
            /* actions: */ accumAsLeafAction,
            this.currentSeq,
            this.clientId,
            /* accum: */ callback,
            start,
            end);
    }

    public getText(start?: number, end?: number): string {
        return this.sharedString.getText(start, end);
    }

    public on(event: "sequenceDelta", listener: (event: SequenceDeltaEvent, target: SharedString, ...args: any[]) => void): this {
        this.maybeSharedString.on("sequenceDelta", listener);
        return this;
    }

    public off(event: "sequenceDelta", listener: (event: SequenceDeltaEvent, target: SharedString, ...args: any[]) => void): this {
        this.maybeSharedString.off("sequenceDelta", listener);
        return this;
    }

    public toString() {
        const s: string[] = [];
        this.visitRange((position, segment) => {
            const kind = getDocSegmentKind(segment);
            switch (kind) {
                case DocSegmentKind.text:
                    s.push((segment as TextSegment).text);
                    break;
                case DocSegmentKind.beginTags:
                    for (const tag of segment.properties.tags) {
                        s.push(`<${tag}>`);
                    }
                    break;
                case DocSegmentKind.endTags:
                    segment = this.getStart(segment as Marker);
                    const tags = segment.properties.tags.slice().reverse();
                    for (const tag of tags) {
                        s.push(`</${tag}>`);
                    }
                    break;
                default:
                    s.push(kind);
            }
            return true;
        });
        return s.join("");
    }

    protected async componentInitializingFirstTime() {
        // For 'findTile(..)', we must enable tracking of left/rightmost tiles:
        // (See: https://github.com/Microsoft/Prague/pull/1118)
        Object.assign(this.runtime, { options: {...(this.runtime.options || {}),  blockUpdateMarkers: true} });

        const text = SharedString.create(this.runtime, "text");
        this.root.set("text", text);
    }

    protected async componentHasInitialized() {
        this.maybeSharedString = await this.root.wait<SharedString>("text");
        this.maybeClient = this.sharedString.client;
    }

    private getOppositeMarker(marker: Marker, oldPrefixLength: number, newPrefix: string) {
        return this.mergeTree.idToSegment[`${newPrefix}${marker.getId().slice(oldPrefixLength)}`];
    }

    private updateCssClassList(start: number, end: number, callback: (classList: string) => string) {
        // tslint:disable-next-line:prefer-array-literal
        const updates: Array<{span: SegmentSpan, classList: string}> = [];

        this.visitRange((position, segment, startOffset, endOffset) => {
            const oldList = getCss(segment).classList;
            const newList = callback(oldList);

            if (newList !== oldList) {
                updates.push({
                    classList: newList,
                    span: new SegmentSpan(position, segment, startOffset, endOffset),
                });
            }

            return true;
        }, start, end);

        for (const { span, classList } of updates) {
            this.annotate(span.startPosition, span.endPosition, { classList });
        }
    }
}

export const flowDocumentFactory = new SharedComponentFactory(FlowDocument, [new MapExtension(), new SharedStringExtension()]);
