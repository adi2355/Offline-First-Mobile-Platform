import XCTest
@testable import AppPlatform
final class AtomicBoolTests: XCTestCase {
    func testInitialValue_False() {
        let flag = AtomicBool(false)
        XCTAssertFalse(flag.value)
    }
    func testInitialValue_True() {
        let flag = AtomicBool(true)
        XCTAssertTrue(flag.value)
    }
    func testSetAndGet_SameThread() {
        let flag = AtomicBool(false)
        flag.value = true
        XCTAssertTrue(flag.value)
        flag.value = false
        XCTAssertFalse(flag.value)
    }
    func testConcurrentReadsAndWrites_NoCrash() {
        let flag = AtomicBool(false)
        let iterations = 10_000
        let threadCount = 10
        let expectation = self.expectation(description: "concurrent")
        expectation.expectedFulfillmentCount = threadCount
        for _ in 0..<threadCount {
            DispatchQueue.global(qos: .userInitiated).async {
                for i in 0..<iterations {
                    if i % 2 == 0 {
                        flag.value = true
                    } else {
                        _ = flag.value
                    }
                }
                expectation.fulfill()
            }
        }
        waitForExpectations(timeout: 10.0)
    }
    func testRapidToggle_NoCrash() {
        let flag = AtomicBool(false)
        let iterations = 50_000
        let expectation = self.expectation(description: "toggle")
        expectation.expectedFulfillmentCount = 2
        DispatchQueue.global(qos: .userInitiated).async {
            for _ in 0..<iterations {
                flag.value = true
            }
            expectation.fulfill()
        }
        DispatchQueue.global(qos: .userInitiated).async {
            for _ in 0..<iterations {
                flag.value = false
            }
            expectation.fulfill()
        }
        waitForExpectations(timeout: 10.0)
    }
    func testCrossThreadVisibility() {
        let flag = AtomicBool(false)
        let expectation = self.expectation(description: "visibility")
        DispatchQueue.global(qos: .userInitiated).async {
            flag.value = true
            usleep(1000) 
            DispatchQueue.global(qos: .default).async {
                XCTAssertTrue(flag.value, "Value set on one thread must be visible on another")
                expectation.fulfill()
            }
        }
        waitForExpectations(timeout: 5.0)
    }
}
