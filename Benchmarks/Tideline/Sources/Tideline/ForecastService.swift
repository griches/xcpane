import Foundation

public struct ForecastService {
    public let baseURL: URL
    public let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    public func readings(for station: TideStation) async throws -> [TideReading] {
        let url = baseURL.appendingPathComponent("stations/\(station.id)/readings")
        let (data, response) = try await session.data(from: url)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let readings: [TideReading] = decoder.decode(TideReading.self, from: data)
        return readings.sorted { $0.time < $1.time }
    }

    public func nextHighTide(for station: TideStation) async throws -> TideReading? {
        let all = try await readings(for: station)
        return all.max { $0.metres < $1.metres }
    }
}
