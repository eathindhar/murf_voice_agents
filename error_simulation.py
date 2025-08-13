#!/usr/bin/env python3
"""
Error Simulation Testing Script for AI Voice Assistant
This script helps test various error scenarios to validate error handling robustness.
"""

import os
import time
import requests
import json
from pathlib import Path
import tempfile
import wave
import numpy as np
from typing import Dict, Any, Optional

class ErrorSimulationTester:
    def __init__(self, base_url: str = "http://localhost:8000"):
        self.base_url = base_url
        self.test_results = []
        
    def log_test_result(self, test_name: str, success: bool, response_data: Dict[Any, Any], error_msg: str = ""):
        """Log test results for analysis"""
        result = {
            "test_name": test_name,
            "success": success,
            "timestamp": time.time(),
            "response_data": response_data,
            "error_message": error_msg
        }
        self.test_results.append(result)
        
        status = "✅ PASS" if success else "❌ FAIL"
        print(f"{status} {test_name}")
        if error_msg:
            print(f"   Error: {error_msg}")
        print(f"   Response: {json.dumps(response_data, indent=2)[:200]}...")
        print("-" * 50)

    def create_test_audio(self, duration: float = 2.0, sample_rate: int = 44100) -> bytes:
        """Create a simple test audio file in memory"""
        try:
            # Generate a simple sine wave
            t = np.linspace(0, duration, int(sample_rate * duration))
            audio_data = np.sin(2 * np.pi * 440 * t)  # 440 Hz sine wave
            
            # Convert to 16-bit PCM
            audio_data = (audio_data * 32767).astype(np.int16)
            
            # Create WAV file in memory
            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp_file:
                with wave.open(tmp_file.name, 'wb') as wav_file:
                    wav_file.setnchannels(1)  # Mono
                    wav_file.setsampwidth(2)  # 2 bytes per sample
                    wav_file.setframerate(sample_rate)
                    wav_file.writeframes(audio_data.tobytes())
                
                # Read the file back as bytes
                tmp_file.seek(0)
                with open(tmp_file.name, 'rb') as f:
                    audio_bytes = f.read()
                
                # Clean up
                os.unlink(tmp_file.name)
                return audio_bytes
                
        except Exception as e:
            print(f"Failed to create test audio: {e}")
            return b""

    def create_corrupted_audio(self) -> bytes:
        """Create corrupted audio data for testing"""
        return b"This is not audio data, just random bytes for testing error handling"

    def test_health_check(self):
        """Test the health check endpoint"""
        try:
            response = requests.get(f"{self.base_url}/health", timeout=10)
            self.log_test_result(
                "Health Check", 
                response.status_code == 200,
                response.json() if response.status_code == 200 else {"status_code": response.status_code}
            )
        except Exception as e:
            self.log_test_result("Health Check", False, {}, str(e))

    def test_missing_api_keys(self):
        """Test behavior when API keys are missing (simulated by invalid keys)"""
        # This test assumes you've temporarily removed or invalidated API keys
        print("⚠️  To test this scenario, temporarily comment out API keys in your .env file")
        
        audio_data = self.create_test_audio()
        if not audio_data:
            self.log_test_result("Missing API Keys Test", False, {}, "Failed to create test audio")
            return
            
        try:
            files = {'audio_file': ('test.wav', audio_data, 'audio/wav')}
            response = requests.post(f"{self.base_url}/agent/chat/test_session", files=files, timeout=30)
            
            # We expect this to fail gracefully with proper error messages
            response_data = response.json()
            
            # Check if response contains fallback messages
            has_fallback = (
                'fallback_message' in response_data or 
                'api_unavailable' in str(response_data) or
                'unavailable' in str(response_data).lower()
            )
            
            self.log_test_result(
                "Missing API Keys Handling",
                response.status_code in [503, 500] and has_fallback,
                response_data
            )
            
        except Exception as e:
            self.log_test_result("Missing API Keys Test", False, {}, str(e))

    def test_corrupted_audio_input(self):
        """Test handling of corrupted audio data"""
        corrupted_audio = self.create_corrupted_audio()
        
        try:
            files = {'audio_file': ('corrupted.wav', corrupted_audio, 'audio/wav')}
            response = requests.post(f"{self.base_url}/agent/chat/test_session_corrupted", files=files, timeout=30)
            
            response_data = response.json()
            
            # Should handle gracefully with appropriate error message
            is_handled_gracefully = (
                response.status_code in [400, 503] and 
                ('error' in response_data or 'fallback_message' in response_data)
            )
            
            self.log_test_result(
                "Corrupted Audio Handling",
                is_handled_gracefully,
                response_data
            )
            
        except Exception as e:
            self.log_test_result("Corrupted Audio Test", False, {}, str(e))

    def test_empty_audio_input(self):
        """Test handling of empty/silent audio"""
        try:
            # Create very short or silent audio
            silent_audio = self.create_test_audio(duration=0.1)  # Very short
            
            files = {'audio_file': ('silent.wav', silent_audio, 'audio/wav')}
            response = requests.post(f"{self.base_url}/agent/chat/test_session_empty", files=files, timeout=30)
            
            response_data = response.json()
            
            # Should detect no speech and provide helpful message
            is_handled_properly = (
                'No speech detected' in str(response_data) or
                'empty_transcription' in str(response_data) or
                'fallback_message' in response_data
            )
            
            self.log_test_result(
                "Empty Audio Handling",
                is_handled_properly,
                response_data
            )
            
        except Exception as e:
            self.log_test_result("Empty Audio Test", False, {}, str(e))

    def test_network_timeout(self):
        """Test network timeout handling"""
        audio_data = self.create_test_audio()
        if not audio_data:
            return
            
        try:
            files = {'audio_file': ('test.wav', audio_data, 'audio/wav')}
            # Use very short timeout to simulate network issues
            response = requests.post(
                f"{self.base_url}/agent/chat/test_session_timeout", 
                files=files, 
                timeout=0.1  # Very short timeout
            )
            
            # This should timeout
            self.log_test_result("Network Timeout Test", False, {}, "Expected timeout did not occur")
            
        except requests.exceptions.Timeout:
            self.log_test_result("Network Timeout Handling", True, {"timeout_handled": True})
        except Exception as e:
            self.log_test_result("Network Timeout Test", False, {}, str(e))

    def test_large_audio_file(self):
        """Test handling of excessively large audio files"""
        try:
            # Create a longer audio file (might hit size limits)
            large_audio = self.create_test_audio(duration=30.0)  # 30 seconds
            
            files = {'audio_file': ('large.wav', large_audio, 'audio/wav')}
            response = requests.post(f"{self.base_url}/agent/chat/test_session_large", files=files, timeout=60)
            
            response_data = response.json()
            
            # Should either process successfully or fail gracefully
            self.log_test_result(
                "Large Audio File Handling",
                response.status_code in [200, 206, 413, 503],  # Various acceptable responses
                response_data
            )
            
        except Exception as e:
            self.log_test_result("Large Audio File Test", False, {}, str(e))

    def test_invalid_session_operations(self):
        """Test session management error handling"""
        try:
            # Test getting history for non-existent session
            response = requests.get(f"{self.base_url}/agent/history/non_existent_session_12345")
            
            response_data = response.json()
            
            # Should return new session response
            is_handled = (
                response.status_code == 200 and 
                response_data.get('status') == 'new_session'
            )
            
            self.log_test_result(
                "Invalid Session Handling",
                is_handled,
                response_data
            )
            
        except Exception as e:
            self.log_test_result("Invalid Session Test", False, {}, str(e))

    def test_text_to_speech_fallback(self):
        """Test TTS service fallback behavior"""
        try:
            # Test with a very long text that might cause TTS issues
            long_text = "This is a very long text message. " * 100  # Very long text
            
            response = requests.post(
                f"{self.base_url}/generate-audio",
                json={"text": long_text, "voice_id": "en-US-natalie"},
                timeout=30
            )
            
            response_data = response.json()
            
            # Should either succeed or provide graceful fallback
            is_handled = (
                response.status_code in [200, 206, 503] and
                ('audio_url' in response_data or 'fallback_message' in response_data)
            )
            
            self.log_test_result(
                "TTS Fallback Handling",
                is_handled,
                response_data
            )
            
        except Exception as e:
            self.log_test_result("TTS Fallback Test", False, {}, str(e))

    def test_concurrent_requests(self):
        """Test handling of concurrent requests to the same session"""
        import threading
        import concurrent.futures
        
        audio_data = self.create_test_audio()
        if not audio_data:
            return
            
        def make_request(session_suffix):
            try:
                files = {'audio_file': (f'test_{session_suffix}.wav', audio_data, 'audio/wav')}
                response = requests.post(
                    f"{self.base_url}/agent/chat/concurrent_test_session", 
                    files=files, 
                    timeout=30
                )
                return response.status_code, response.json()
            except Exception as e:
                return 500, {"error": str(e)}
        
        # Make multiple concurrent requests
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            futures = [executor.submit(make_request, i) for i in range(3)]
            results = [future.result() for future in concurrent.futures.as_completed(futures)]
        
        successful_requests = sum(1 for status, _ in results if status in [200, 206])
        
        self.log_test_result(
            "Concurrent Requests Handling",
            successful_requests >= 1,  # At least one should succeed
            {"successful_requests": successful_requests, "total_requests": 3}
        )

    def run_all_tests(self):
        """Run all error simulation tests"""
        print("🧪 Starting Error Simulation Tests")
        print("=" * 60)
        
        tests = [
            self.test_health_check,
            self.test_corrupted_audio_input,
            self.test_empty_audio_input,
            self.test_network_timeout,
            self.test_large_audio_file,
            self.test_invalid_session_operations,
            self.test_text_to_speech_fallback,
            self.test_concurrent_requests,
            # self.test_missing_api_keys,  # Uncomment to test API key scenarios
        ]
        
        for test in tests:
            try:
                test()
                time.sleep(1)  # Brief pause between tests
            except Exception as e:
                print(f"❌ Test {test.__name__} crashed: {e}")
        
        self.generate_test_report()

    def generate_test_report(self):
        """Generate a comprehensive test report"""
        print("\n" + "=" * 60)
        print("🔍 ERROR HANDLING TEST REPORT")
        print("=" * 60)
        
        total_tests = len(self.test_results)
        passed_tests = sum(1 for result in self.test_results if result['success'])
        failed_tests = total_tests - passed_tests
        
        print(f"📊 Total Tests: {total_tests}")
        print(f"✅ Passed: {passed_tests}")
        print(f"❌ Failed: {failed_tests}")
        print(f"📈 Success Rate: {(passed_tests/total_tests)*100:.1f}%")
        
        print("\n📋 Test Summary:")
        print("-" * 40)
        for result in self.test_results:
            status = "✅ PASS" if result['success'] else "❌ FAIL"
            print(f"{status} {result['test_name']}")
            if not result['success'] and result['error_message']:
                print(f"    └─ {result['error_message']}")
        
        # Generate detailed JSON report
        report_file = f"error_handling_test_report_{int(time.time())}.json"
        with open(report_file, 'w') as f:
            json.dump({
                "summary": {
                    "total_tests": total_tests,
                    "passed_tests": passed_tests,
                    "failed_tests": failed_tests,
                    "success_rate": (passed_tests/total_tests)*100
                },
                "test_results": self.test_results,
                "timestamp": time.time()
            }, f, indent=2)
        
        print(f"\n📄 Detailed report saved to: {report_file}")
        
        # Recommendations based on results
        print("\n💡 RECOMMENDATIONS:")
        print("-" * 20)
        
        if failed_tests == 0:
            print("🎉 Excellent! All error handling tests passed.")
            print("   Your application shows robust error handling capabilities.")
        elif failed_tests <= 2:
            print("✨ Good! Most error scenarios are handled well.")
            print("   Consider reviewing the failed tests for improvements.")
        else:
            print("⚠️  Multiple error handling issues detected.")
            print("   Recommend implementing additional error handling measures.")
        
        # Specific recommendations based on failed tests
        failed_test_names = [result['test_name'] for result in self.test_results if not result['success']]
        
        if "Health Check" in failed_test_names:
            print("   • Implement health check endpoint for system monitoring")
        
        if "Corrupted Audio Handling" in failed_test_names:
            print("   • Add audio format validation before processing")
        
        if "Network Timeout Handling" in failed_test_names:
            print("   • Implement proper timeout handling and retry logic")
        
        if "TTS Fallback Handling" in failed_test_names:
            print("   • Consider implementing backup TTS services or pre-recorded messages")

class ErrorScenarioGenerator:
    """Generate specific error scenarios for testing"""
    
    @staticmethod
    def simulate_api_key_error():
        """Instructions for simulating API key errors"""
        print("\n🔧 SIMULATING API KEY ERRORS:")
        print("=" * 40)
        print("1. Backup your current .env file")
        print("2. Comment out or invalidate these lines in .env:")
        print("   # API_KEY=your_murf_api_key")
        print("   # ASSEMBLYAI_API_KEY=your_assemblyai_key")
        print("3. Restart your FastAPI server")
        print("4. Run the test again")
        print("5. Restore your .env file when done")
        print("\nExpected behavior:")
        print("✅ Application should return fallback messages")
        print("✅ Users should receive helpful error explanations")
        print("✅ No application crashes or 500 errors")

    @staticmethod
    def simulate_service_overload():
        """Instructions for simulating service overload"""
        print("\n🚀 SIMULATING SERVICE OVERLOAD:")
        print("=" * 40)
        print("1. Use a load testing tool like 'ab' or 'wrk':")
        print("   ab -n 100 -c 10 http://localhost:8000/health")
        print("2. Or run multiple concurrent test sessions")
        print("3. Monitor server logs for error handling")
        print("\nExpected behavior:")
        print("✅ Server should handle concurrent requests gracefully")
        print("✅ Response times may increase but no crashes")
        print("✅ Proper error responses for failed requests")

    @staticmethod
    def simulate_network_issues():
        """Instructions for simulating network issues"""
        print("\n🌐 SIMULATING NETWORK ISSUES:")
        print("=" * 40)
        print("1. Use network throttling tools:")
        print("   • Chrome DevTools (Network tab -> Throttling)")
        print("   • Charles Proxy for mobile testing")
        print("   • tc (traffic control) on Linux")
        print("2. Test with different connection speeds:")
        print("   • Slow 3G, Fast 3G, WiFi")
        print("3. Simulate intermittent connectivity")
        print("\nExpected behavior:")
        print("✅ Graceful degradation with slow connections")
        print("✅ Retry logic for failed requests")
        print("✅ User feedback about connection issues")

def main():
    """Main function to run error simulation tests"""
    import argparse
    
    parser = argparse.ArgumentParser(description="AI Voice Assistant Error Handling Tester")
    parser.add_argument("--url", default="http://localhost:8000", help="Base URL of the API server")
    parser.add_argument("--scenarios", action="store_true", help="Show error simulation scenarios")
    parser.add_argument("--test", default="all", choices=["all", "basic", "network", "audio"], 
                       help="Type of tests to run")
    
    args = parser.parse_args()
    
    if args.scenarios:
        print("🧪 ERROR SIMULATION SCENARIOS")
        print("=" * 50)
        ErrorScenarioGenerator.simulate_api_key_error()
        ErrorScenarioGenerator.simulate_service_overload()
        ErrorScenarioGenerator.simulate_network_issues()
        return
    
    # Check if server is running
    try:
        response = requests.get(f"{args.url}/health", timeout=5)
        print(f"✅ Server is running at {args.url}")
    except:
        print(f"❌ Server not reachable at {args.url}")
        print("Please start your FastAPI server first:")
        print("   python main.py")
        return
    
    # Run tests
    tester = ErrorSimulationTester(args.url)
    
    if args.test == "all":
        tester.run_all_tests()
    elif args.test == "basic":
        tester.test_health_check()
        tester.test_invalid_session_operations()
        tester.test_text_to_speech_fallback()
    elif args.test == "network":
        tester.test_network_timeout()
        tester.test_concurrent_requests()
    elif args.test == "audio":
        tester.test_corrupted_audio_input()
        tester.test_empty_audio_input()
        tester.test_large_audio_file()

if __name__ == "__main__":
    main()

# Additional utility functions for manual testing

def create_test_scenarios():
    """Create test scenarios for manual testing"""
    scenarios = {
        "normal_operation": {
            "description": "Test normal operation with good audio",
            "audio_duration": 3.0,
            "expected_result": "successful_conversation"
        },
        "poor_audio_quality": {
            "description": "Test with very quiet or noisy audio",
            "audio_duration": 2.0,
            "expected_result": "transcription_error_handling"
        },
        "very_long_speech": {
            "description": "Test with very long speech input",
            "audio_duration": 30.0,
            "expected_result": "processing_timeout_or_success"
        },
        "rapid_successive_requests": {
            "description": "Test rapid successive requests to same session",
            "request_count": 5,
            "expected_result": "queuing_or_rejection_handling"
        }
    }
    
    return scenarios

def monitor_error_patterns():
    """Monitor and analyze error patterns over time"""
    print("📊 ERROR PATTERN MONITORING")
    print("=" * 30)
    print("This would typically integrate with:")
    print("• Application Performance Monitoring (APM) tools")
    print("• Log aggregation systems (ELK stack, Splunk)")
    print("• Error tracking services (Sentry, Rollbar)")
    print("• Custom metrics dashboards (Grafana, DataDog)")
    
    print("\nKey metrics to track:")
    print("• Error rate by service (STT, LLM, TTS)")
    print("• Average response time per endpoint")
    print("• Retry success rates")
    print("• User session completion rates")
    print("• Geographic error distribution")

# Performance testing utilities
def stress_test_endpoints():
    """Stress test all endpoints to identify breaking points"""
    endpoints = [
        "/health",
        "/generate-audio",
        "/agent/chat/stress_test_session",
        "/agent/history/stress_test_session"
    ]
    
    print("🔥 STRESS TESTING ENDPOINTS")
    print("=" * 30)
    for endpoint in endpoints:
        print(f"Testing: {endpoint}")
        print("Use tools like:")
        print(f"  ab -n 1000 -c 50 http://localhost:8000{endpoint}")
        print(f"  wrk -t12 -c400 -d30s http://localhost:8000{endpoint}")
        print()

if __name__ == "__main__":
    # If running directly, provide usage examples
    print("🧪 AI Voice Assistant Error Handling Test Suite")
    print("=" * 50)
    print("Usage examples:")
    print("  python error_simulation.py                    # Run all tests")
    print("  python error_simulation.py --scenarios        # Show simulation scenarios")
    print("  python error_simulation.py --test basic       # Run basic tests only")
    print("  python error_simulation.py --url http://localhost:8080  # Custom URL")
    print()
    print("Make sure your FastAPI server is running before executing tests!")
    
    main()