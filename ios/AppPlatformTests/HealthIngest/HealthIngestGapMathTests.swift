import XCTest
@testable import AppPlatform
final class ComputeHotTwoPassGapTests: XCTestCase {
    private let overlapMs: Int64 = 300_000               
    private let maxHotWindowMs: Int64 = 14 * 86_400_000  
    private let hotUiWindowMs: Int64 = 86_400_000        
    func testFreshWatermark_NoGap() {
        let nowMs: Int64 = 1_700_000_000_000
        let watermarkMs: Int64 = nowMs - 3_600_000  
        let result = computeHotTwoPassGap(
            watermarkMs: watermarkMs,
            nowMs: nowMs,
            overlapMs: overlapMs,
            maxHotWindowMs: maxHotWindowMs,
            hotUiWindowMs: hotUiWindowMs
        )
        XCTAssertNil(result, "Fresh watermark (within UI window) should produce no gap")
    }
    func testStaleWatermark_ReturnsGap() {
        let nowMs: Int64 = 1_700_000_000_000
        let watermarkMs: Int64 = nowMs - (48 * 3_600_000)  
        let result = computeHotTwoPassGap(
            watermarkMs: watermarkMs,
            nowMs: nowMs,
            overlapMs: overlapMs,
            maxHotWindowMs: maxHotWindowMs,
            hotUiWindowMs: hotUiWindowMs
        )
        XCTAssertNotNil(result, "48h-old watermark should produce a gap")
        let expectedGapStart = watermarkMs - overlapMs
        XCTAssertEqual(result!.gapStart, expectedGapStart)
        let expectedGapEnd = nowMs - hotUiWindowMs
        XCTAssertEqual(result!.gapEnd, expectedGapEnd)
        XCTAssertGreaterThan(result!.gapEnd, result!.gapStart)
    }
    func testWatermarkExactlyAtBoundary_NoGap() {
        let nowMs: Int64 = 1_700_000_000_000
        let watermarkMs: Int64 = nowMs - hotUiWindowMs + overlapMs
        let result = computeHotTwoPassGap(
            watermarkMs: watermarkMs,
            nowMs: nowMs,
            overlapMs: overlapMs,
            maxHotWindowMs: maxHotWindowMs,
            hotUiWindowMs: hotUiWindowMs
        )
        XCTAssertNil(result, "Boundary case (gapEnd == gapStart) should return nil")
    }
    func testOverlapExpands_GapStartClampedToMaxWindow() {
        let nowMs: Int64 = 1_700_000_000_000
        let watermarkMs: Int64 = nowMs - (30 * 86_400_000)  
        let result = computeHotTwoPassGap(
            watermarkMs: watermarkMs,
            nowMs: nowMs,
            overlapMs: overlapMs,
            maxHotWindowMs: maxHotWindowMs,
            hotUiWindowMs: hotUiWindowMs
        )
        XCTAssertNotNil(result)
        XCTAssertEqual(result!.gapStart, nowMs - maxHotWindowMs,
                       "gapStart should be clamped to maxHotWindowMs when watermark is very old")
    }
    func testVeryOldWatermark_GapStartAtMaxWindow() {
        let nowMs: Int64 = 1_700_000_000_000
        let watermarkMs: Int64 = nowMs - (365 * 86_400_000)  
        let result = computeHotTwoPassGap(
            watermarkMs: watermarkMs,
            nowMs: nowMs,
            overlapMs: overlapMs,
            maxHotWindowMs: maxHotWindowMs,
            hotUiWindowMs: hotUiWindowMs
        )
        XCTAssertNotNil(result)
        XCTAssertEqual(result!.gapStart, nowMs - maxHotWindowMs)
        XCTAssertEqual(result!.gapEnd, nowMs - hotUiWindowMs)
    }
    func testSmallUiWindow_LargerGap() {
        let nowMs: Int64 = 1_700_000_000_000
        let watermarkMs: Int64 = nowMs - (48 * 3_600_000)  
        let smallUiWindowMs: Int64 = 3_600_000  
        let result = computeHotTwoPassGap(
            watermarkMs: watermarkMs,
            nowMs: nowMs,
            overlapMs: overlapMs,
            maxHotWindowMs: maxHotWindowMs,
            hotUiWindowMs: smallUiWindowMs
        )
        XCTAssertNotNil(result)
        XCTAssertEqual(result!.gapEnd, nowMs - smallUiWindowMs)
        XCTAssertGreaterThan(result!.gapEnd - result!.gapStart,
                             (nowMs - hotUiWindowMs) - (watermarkMs - overlapMs),
                             "Smaller UI window should produce a larger gap")
    }
    func testWatermarkAtEpoch_MaxGap() {
        let nowMs: Int64 = 1_700_000_000_000
        let watermarkMs: Int64 = 0
        let result = computeHotTwoPassGap(
            watermarkMs: watermarkMs,
            nowMs: nowMs,
            overlapMs: overlapMs,
            maxHotWindowMs: maxHotWindowMs,
            hotUiWindowMs: hotUiWindowMs
        )
        XCTAssertNotNil(result)
        XCTAssertEqual(result!.gapStart, nowMs - maxHotWindowMs)
        XCTAssertEqual(result!.gapEnd, nowMs - hotUiWindowMs)
    }
    func testNegativeGap_ReturnsNil() {
        let nowMs: Int64 = 1_700_000_000_000
        let watermarkMs: Int64 = nowMs - (48 * 3_600_000)
        let hugeUiWindowMs: Int64 = 30 * 86_400_000  
        let result = computeHotTwoPassGap(
            watermarkMs: watermarkMs,
            nowMs: nowMs,
            overlapMs: overlapMs,
            maxHotWindowMs: maxHotWindowMs,
            hotUiWindowMs: hugeUiWindowMs
        )
        XCTAssertNil(result, "When hotUiWindowMs exceeds maxHotWindowMs, gap should be nil")
    }
}
final class ComputeCatchupChunksTests: XCTestCase {
    func testSingleChunk_ExactFit() {
        let chunkMs: Int64 = 21_600_000  
        let gapStart: Int64 = 1_000_000
        let gapEnd: Int64 = gapStart + chunkMs
        let chunks = computeCatchupChunks(
            gapStart: gapStart,
            gapEnd: gapEnd,
            chunkMs: chunkMs,
            maxChunks: 4
        )
        XCTAssertEqual(chunks.count, 1)
        XCTAssertEqual(chunks[0].start, gapStart)
        XCTAssertEqual(chunks[0].end, gapEnd)
    }
    func testMultipleChunks_EvenSplit() {
        let chunkMs: Int64 = 10_000
        let gapStart: Int64 = 0
        let gapEnd: Int64 = 30_000
        let chunks = computeCatchupChunks(
            gapStart: gapStart,
            gapEnd: gapEnd,
            chunkMs: chunkMs,
            maxChunks: 10
        )
        XCTAssertEqual(chunks.count, 3)
        XCTAssertEqual(chunks[0].start, 0)
        XCTAssertEqual(chunks[0].end, 10_000)
        XCTAssertEqual(chunks[1].start, 10_000)
        XCTAssertEqual(chunks[1].end, 20_000)
        XCTAssertEqual(chunks[2].start, 20_000)
        XCTAssertEqual(chunks[2].end, 30_000)
    }
    func testFinalChunk_ClampedToGapEnd() {
        let chunkMs: Int64 = 10_000
        let gapStart: Int64 = 0
        let gapEnd: Int64 = 25_000  
        let chunks = computeCatchupChunks(
            gapStart: gapStart,
            gapEnd: gapEnd,
            chunkMs: chunkMs,
            maxChunks: 10
        )
        XCTAssertEqual(chunks.count, 3)
        XCTAssertEqual(chunks[2].start, 20_000)
        XCTAssertEqual(chunks[2].end, 25_000, "Final chunk should be clamped to gapEnd")
    }
    func testMaxChunks_LimitsOutput() {
        let chunkMs: Int64 = 10_000
        let gapStart: Int64 = 0
        let gapEnd: Int64 = 100_000  
        let chunks = computeCatchupChunks(
            gapStart: gapStart,
            gapEnd: gapEnd,
            chunkMs: chunkMs,
            maxChunks: 4
        )
        XCTAssertEqual(chunks.count, 4, "Should be limited to maxChunks")
        XCTAssertEqual(chunks[3].end, 40_000)
    }
    func testZeroGap_EmptyChunks() {
        let chunks = computeCatchupChunks(
            gapStart: 100,
            gapEnd: 100,
            chunkMs: 10_000,
            maxChunks: 4
        )
        XCTAssertTrue(chunks.isEmpty, "Zero-width gap should produce no chunks")
    }
    func testSingleMs_Gap_OneChunk() {
        let chunks = computeCatchupChunks(
            gapStart: 1000,
            gapEnd: 1001,
            chunkMs: 10_000,
            maxChunks: 4
        )
        XCTAssertEqual(chunks.count, 1)
        XCTAssertEqual(chunks[0].start, 1000)
        XCTAssertEqual(chunks[0].end, 1001)
    }
}
