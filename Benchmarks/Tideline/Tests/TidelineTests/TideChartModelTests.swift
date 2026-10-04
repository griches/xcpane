import XCTest
@testable import Tideline

final class TideChartModelTests: XCTestCase {
    private let readings = [
        TideReading(time: Date(timeIntervalSince1970: 0), heightText: "1.2"),
        TideReading(time: Date(timeIntervalSince1970: 3600), heightText: "4.6"),
    ]

    func testHighestInMetres() {
        XCTAssertEqual(TideChartModel(readings: readings, unit: .metres).highest, 4.6, accuracy: 0.001)
    }

    func testLabelUsesUnitSymbol() {
        let model = TideChartModel(readings: readings, unit: .feet)
        XCTAssertEqual(model.label(for: readings[1]), "15.1ft")
    }
}
